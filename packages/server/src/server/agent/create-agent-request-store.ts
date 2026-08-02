import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensurePrivateFile } from "../private-files.js";

export const CREATE_AGENT_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CREATE_AGENT_REQUEST_MAX_RECEIPTS = 10_000;
export const CREATE_AGENT_REQUEST_MAX_FILE_BYTES = 4 * 1024 * 1024;

const CREATE_AGENT_REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CreateAgentRequestIdentitySchema = z
  .object({
    callerId: z.string().min(1).max(200),
    action: z.literal("create_agent"),
    daemonId: z.string().min(1).max(200),
    key: z.string().regex(CREATE_AGENT_REQUEST_KEY_PATTERN),
  })
  .strict();

const CreateAgentRequestReceiptSchema = CreateAgentRequestIdentitySchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  agentId: z.string().min(1).max(200),
  state: z.enum(["pending", "succeeded", "failed"]),
  phase: z.enum(["reserved", "placement_created", "agent_registered", "prompt_dispatched"]),
  placement: z
    .object({ workspaceId: z.string().min(1).max(200), cwd: z.string().min(1).max(4096) })
    .strict()
    .optional(),
  updatedAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.phase === "placement_created" && !receipt.placement) {
      context.addIssue({
        code: "custom",
        path: ["placement"],
        message: "placement_created receipts require durable placement",
      });
    }
    if (receipt.state === "failed" && receipt.phase !== "reserved") {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "only pre-placement failures can be terminal",
      });
    }
  });

const CreateAgentRequestReceiptFileSchema = z
  .object({
    version: z.literal(2),
    receipts: z.array(CreateAgentRequestReceiptSchema).max(CREATE_AGENT_REQUEST_MAX_RECEIPTS),
  })
  .strict();

type CreateAgentRequestReceipt = z.infer<typeof CreateAgentRequestReceiptSchema>;

export type CreateAgentRequestPhase = CreateAgentRequestReceipt["phase"];

export interface CreateAgentRequestContext {
  agentId: string;
  phase: CreateAgentRequestPhase;
  placement?: { workspaceId: string; cwd: string };
  checkpoint(
    phase: Exclude<CreateAgentRequestPhase, "reserved">,
    placement?: { workspaceId: string; cwd: string },
  ): Promise<void>;
}

export type CreateAgentRequestIdentity = z.infer<typeof CreateAgentRequestIdentitySchema>;

export class CreateAgentIdempotencyConflictError extends Error {
  constructor() {
    super("Create idempotency key was already used with a different request");
    this.name = "CreateAgentIdempotencyConflictError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function fingerprintCreateAgentRequest(
  request: Record<string, unknown> & { requestId?: unknown; idempotencyKey?: unknown },
): string {
  const { requestId: _requestId, idempotencyKey: _idempotencyKey, ...createIntent } = request;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(createIntent)))
    .digest("hex");
}

interface CreateAgentRequestStoreOptions {
  paseoHome: string;
  daemonId?: string;
  hasAgent: (agentId: string) => Promise<boolean>;
  now?: () => Date;
  idFactory?: (identity: CreateAgentRequestIdentity) => string;
  retentionMs?: number;
  maxReceipts?: number;
  maxFileBytes?: number;
}

interface RunCreateAgentRequestInput {
  key: string;
  callerId: string;
  action: "create_agent";
  fingerprint: string;
  create: (context: CreateAgentRequestContext) => Promise<void>;
}

interface InflightCreateAgentRequest {
  fingerprint: string;
  promise: Promise<string>;
}

export class CreateAgentRequestStore {
  private readonly filePath: string;
  private readonly daemonId: string;
  private readonly hasAgent: (agentId: string) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly idFactory: (identity: CreateAgentRequestIdentity) => string;
  private readonly retentionMs: number;
  private readonly maxReceipts: number;
  private readonly maxFileBytes: number;
  private readonly receipts = new Map<string, CreateAgentRequestReceipt>();
  private readonly inflight = new Map<string, InflightCreateAgentRequest>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: CreateAgentRequestStoreOptions) {
    this.filePath = path.join(options.paseoHome, "create-agent-requests.json");
    this.daemonId = options.daemonId?.trim() || "local-daemon";
    this.hasAgent = options.hasAgent;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? deterministicAgentId;
    this.retentionMs = options.retentionMs ?? CREATE_AGENT_REQUEST_RETENTION_MS;
    this.maxReceipts = options.maxReceipts ?? CREATE_AGENT_REQUEST_MAX_RECEIPTS;
    this.maxFileBytes = options.maxFileBytes ?? CREATE_AGENT_REQUEST_MAX_FILE_BYTES;
  }

  async run(input: RunCreateAgentRequestInput): Promise<string> {
    await this.load();
    const identity = CreateAgentRequestIdentitySchema.parse({
      callerId: input.callerId,
      action: input.action,
      daemonId: this.daemonId,
      key: input.key,
    });
    const scopedKey = fingerprintIdentity(identity);
    await this.pruneExpiredReceipts();

    const inflight = this.inflight.get(scopedKey);
    if (inflight) {
      if (inflight.fingerprint !== input.fingerprint) {
        throw new CreateAgentIdempotencyConflictError();
      }
      return inflight.promise;
    }

    const receipt = this.receipts.get(scopedKey);
    if (receipt && receipt.fingerprint !== input.fingerprint) {
      throw new CreateAgentIdempotencyConflictError();
    }

    const promise = this.execute(input, identity, scopedKey, receipt);
    this.inflight.set(scopedKey, { fingerprint: input.fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.inflight.get(scopedKey)?.promise === promise) {
        this.inflight.delete(scopedKey);
      }
    }
  }

  private async execute(
    input: RunCreateAgentRequestInput,
    identity: CreateAgentRequestIdentity,
    scopedKey: string,
    existing: CreateAgentRequestReceipt | undefined,
  ): Promise<string> {
    if (existing?.state === "failed") {
      throw new Error("The previous create request failed");
    }
    if (existing?.state === "succeeded") {
      if (await this.hasAgent(existing.agentId)) {
        return existing.agentId;
      }
      throw new Error(
        `Agent ${existing.agentId} from the previous create request no longer exists`,
      );
    }

    const agentId = existing?.agentId ?? this.idFactory(identity);
    if (!existing && (await this.hasAgent(agentId))) {
      throw new Error("The create idempotency receipt expired; refusing to create a duplicate");
    }
    if (!existing && this.receipts.size >= this.maxReceipts) {
      throw new Error(`Create idempotency receipt limit of ${this.maxReceipts} was reached`);
    }

    let pending: CreateAgentRequestReceipt = existing ?? {
      ...identity,
      fingerprint: input.fingerprint,
      agentId,
      state: "pending",
      phase: "reserved",
      updatedAt: this.now().toISOString(),
    };
    pending = await this.updateReceipt(scopedKey, pending);

    try {
      await input.create({
        agentId: pending.agentId,
        phase: pending.phase,
        placement: pending.placement,
        checkpoint: async (phase, placement) => {
          assertPhaseTransition(pending.phase, phase);
          pending = await this.updateReceipt(scopedKey, {
            ...pending,
            phase,
            ...(placement ? { placement } : {}),
          });
        },
      });
      await this.updateReceipt(scopedKey, { ...pending, state: "succeeded" });
      return pending.agentId;
    } catch (error) {
      const agentWasRegistered =
        CREATE_AGENT_PHASE_ORDER[pending.phase] < CREATE_AGENT_PHASE_ORDER.agent_registered &&
        (await this.hasAgent(pending.agentId));
      await this.updateReceipt(scopedKey, {
        ...pending,
        state: pending.phase === "reserved" && !agentWasRegistered ? "failed" : "pending",
        ...(agentWasRegistered ? { phase: "agent_registered" as const } : {}),
      });
      throw error;
    }
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (Buffer.byteLength(raw) > this.maxFileBytes) {
      throw new Error(
        `Create idempotency receipt file exceeds ${this.maxFileBytes} bytes; file was preserved`,
      );
    }
    const parsed = CreateAgentRequestReceiptFileSchema.parse(JSON.parse(raw));
    const now = this.now().getTime();
    for (const receipt of parsed.receipts) {
      if (Date.parse(receipt.updatedAt) > now) {
        throw new Error("Create idempotency receipt has a future timestamp; file was preserved");
      }
      const scopedKey = fingerprintIdentity(receipt);
      if (this.receipts.has(scopedKey)) {
        throw new Error("Create idempotency receipt file contains a duplicate scoped key");
      }
      this.receipts.set(scopedKey, receipt);
    }
  }

  private async pruneExpiredReceipts(): Promise<void> {
    const cutoff = this.now().getTime() - this.retentionMs;
    if (![...this.receipts.values()].some((receipt) => Date.parse(receipt.updatedAt) < cutoff)) {
      return;
    }
    await this.mutateAndPersist(() => {
      for (const [scopedKey, receipt] of this.receipts) {
        if (Date.parse(receipt.updatedAt) < cutoff) {
          this.receipts.delete(scopedKey);
        }
      }
    });
  }

  private async updateReceipt(
    scopedKey: string,
    receipt: CreateAgentRequestReceipt,
  ): Promise<CreateAgentRequestReceipt> {
    const updated = { ...receipt, updatedAt: this.now().toISOString() };
    CreateAgentRequestReceiptSchema.parse(updated);
    await this.mutateAndPersist(() => {
      this.receipts.set(scopedKey, updated);
    });
    return updated;
  }

  private async mutateAndPersist(mutate: () => void): Promise<void> {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const previous = new Map(this.receipts);
        try {
          mutate();
          const snapshot = {
            version: 2 as const,
            receipts: Array.from(this.receipts.values()),
          };
          const serialized = JSON.stringify(snapshot, null, 2);
          if (Buffer.byteLength(serialized) > this.maxFileBytes) {
            throw new Error(
              `Create idempotency receipt file limit of ${this.maxFileBytes} bytes was reached`,
            );
          }
          await writeJsonFileAtomic(this.filePath, snapshot);
          ensurePrivateFile(this.filePath);
        } catch (error) {
          this.receipts.clear();
          for (const [scopedKey, receipt] of previous) {
            this.receipts.set(scopedKey, receipt);
          }
          throw error;
        }
        return undefined;
      });
    this.writeQueue = operation;
    await operation;
  }
}

const CREATE_AGENT_PHASE_ORDER: Record<CreateAgentRequestPhase, number> = {
  reserved: 0,
  placement_created: 1,
  agent_registered: 2,
  prompt_dispatched: 3,
};

function assertPhaseTransition(
  current: CreateAgentRequestPhase,
  next: Exclude<CreateAgentRequestPhase, "reserved">,
): void {
  if (CREATE_AGENT_PHASE_ORDER[next] < CREATE_AGENT_PHASE_ORDER[current]) {
    throw new Error(`Create receipt phase cannot move backward from ${current} to ${next}`);
  }
}

function fingerprintIdentity(identity: CreateAgentRequestIdentity): string {
  return createHash("sha256")
    .update(`${identity.daemonId}\0${identity.callerId}\0${identity.action}\0${identity.key}`)
    .digest("hex");
}

function deterministicAgentId(identity: CreateAgentRequestIdentity): string {
  const hash = fingerprintIdentity(identity);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
