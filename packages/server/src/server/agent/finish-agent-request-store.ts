import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensurePrivateFile } from "../private-files.js";

export const FINISH_AGENT_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
export const FINISH_AGENT_REQUEST_MAX_RECEIPTS = 10_000;
export const FINISH_AGENT_REQUEST_MAX_FILE_BYTES = 4 * 1024 * 1024;

const FINISH_AGENT_REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

const FinishAgentRequestIdentitySchema = z
  .object({
    callerId: z.string().min(1).max(200),
    action: z.literal("finish_agent"),
    daemonId: z.string().min(1).max(200),
    key: z.string().regex(FINISH_AGENT_REQUEST_KEY_PATTERN),
  })
  .strict();

const FinishAgentTargetSchema = z
  .object({
    agentId: z.string().min(1).max(200),
    // The exclusively owned Paseo worktree authorized for release, resolved
    // once before any side effect. null means archive-only.
    worktreePath: z.string().min(1).max(4096).nullable(),
    keepWorktree: z.boolean(),
    force: z.boolean(),
  })
  .strict();

const FinishAgentRequestReceiptSchema = FinishAgentRequestIdentitySchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["pending", "succeeded"]),
  phase: z.enum(["authorized", "agent_archived"]),
  target: FinishAgentTargetSchema,
  archivedAt: z.string().min(1).optional(),
  updatedAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.phase === "agent_archived" && !receipt.archivedAt) {
      context.addIssue({
        code: "custom",
        path: ["archivedAt"],
        message: "agent_archived receipts require the durable archive timestamp",
      });
    }
    if (receipt.state === "succeeded" && receipt.phase !== "agent_archived") {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "succeeded receipts require the agent_archived phase",
      });
    }
  });

const FinishAgentRequestReceiptFileSchema = z
  .object({
    version: z.literal(1),
    receipts: z.array(FinishAgentRequestReceiptSchema).max(FINISH_AGENT_REQUEST_MAX_RECEIPTS),
  })
  .strict();

type FinishAgentRequestReceipt = z.infer<typeof FinishAgentRequestReceiptSchema>;

export type FinishAgentTarget = z.infer<typeof FinishAgentTargetSchema>;

export type FinishAgentRequestPhase = FinishAgentRequestReceipt["phase"];

export type FinishAgentWorktreeOutcome = "released" | "kept" | "not_paseo_owned";

export interface FinishAgentOutcome {
  agentId: string;
  archivedAt: string;
  worktree: FinishAgentWorktreeOutcome;
}

export interface FinishAgentRequestContext {
  target: FinishAgentTarget;
  phase: FinishAgentRequestPhase;
  archivedAt: string | null;
  markAgentArchived(archivedAt: string): Promise<void>;
}

export type FinishAgentRequestIdentity = z.infer<typeof FinishAgentRequestIdentitySchema>;

export class FinishAgentIdempotencyConflictError extends Error {
  readonly code = "FINISH_INTENT_CONFLICT";

  constructor() {
    super("Finish idempotency key was already used with a different request");
    this.name = "FinishAgentIdempotencyConflictError";
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

export function fingerprintFinishAgentRequest(intent: {
  agentId: string;
  force: boolean;
  keepWorktree: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          agentId: intent.agentId,
          force: intent.force,
          keepWorktree: intent.keepWorktree,
        }),
      ),
    )
    .digest("hex");
}

interface FinishAgentRequestStoreOptions {
  paseoHome: string;
  daemonId?: string;
  now?: () => Date;
  retentionMs?: number;
  maxReceipts?: number;
  maxFileBytes?: number;
  writeReceiptFile?: typeof writeJsonFileAtomic;
}

interface RunFinishAgentRequestInput {
  key: string;
  callerId: string;
  fingerprint: string;
  authorize: () => Promise<FinishAgentTarget>;
  execute: (context: FinishAgentRequestContext) => Promise<void>;
}

interface InflightFinishAgentRequest {
  fingerprint: string;
  promise: Promise<FinishAgentOutcome>;
}

export class FinishAgentRequestStore {
  private readonly filePath: string;
  private readonly daemonId: string;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly maxReceipts: number;
  private readonly maxFileBytes: number;
  private readonly writeReceiptFile: typeof writeJsonFileAtomic;
  private readonly receipts = new Map<string, FinishAgentRequestReceipt>();
  private readonly inflight = new Map<string, InflightFinishAgentRequest>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FinishAgentRequestStoreOptions) {
    this.filePath = path.join(options.paseoHome, "finish-agent-requests.json");
    this.daemonId = options.daemonId?.trim() || "local-daemon";
    this.now = options.now ?? (() => new Date());
    this.retentionMs = options.retentionMs ?? FINISH_AGENT_REQUEST_RETENTION_MS;
    this.maxReceipts = options.maxReceipts ?? FINISH_AGENT_REQUEST_MAX_RECEIPTS;
    this.maxFileBytes = options.maxFileBytes ?? FINISH_AGENT_REQUEST_MAX_FILE_BYTES;
    this.writeReceiptFile = options.writeReceiptFile ?? writeJsonFileAtomic;
  }

  async run(input: RunFinishAgentRequestInput): Promise<FinishAgentOutcome> {
    await this.load();
    const identity = FinishAgentRequestIdentitySchema.parse({
      callerId: input.callerId,
      action: "finish_agent",
      daemonId: this.daemonId,
      key: input.key,
    });
    const scopedKey = fingerprintIdentity(identity);
    await this.pruneExpiredReceipts();

    const inflight = this.inflight.get(scopedKey);
    if (inflight) {
      if (inflight.fingerprint !== input.fingerprint) {
        throw new FinishAgentIdempotencyConflictError();
      }
      return inflight.promise;
    }

    const receipt = this.receipts.get(scopedKey);
    if (receipt && receipt.fingerprint !== input.fingerprint) {
      throw new FinishAgentIdempotencyConflictError();
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
    input: RunFinishAgentRequestInput,
    identity: FinishAgentRequestIdentity,
    scopedKey: string,
    current: FinishAgentRequestReceipt | undefined,
  ): Promise<FinishAgentOutcome> {
    if (current?.state === "succeeded") {
      return outcomeFromReceipt(current);
    }

    let pending: FinishAgentRequestReceipt;
    if (current) {
      pending = current;
    } else {
      // Authorization (safety checks + worktree resolution) runs before the
      // receipt exists, so a refusal leaves no durable state. The exact
      // authorized target is persisted before any side effect below.
      const target = await input.authorize();
      if (this.receipts.size >= this.maxReceipts) {
        throw new Error(`Finish idempotency receipt limit of ${this.maxReceipts} was reached`);
      }
      pending = await this.updateReceipt(scopedKey, {
        ...identity,
        fingerprint: input.fingerprint,
        state: "pending",
        phase: "authorized",
        target,
        updatedAt: this.now().toISOString(),
      });
    }

    await input.execute({
      target: pending.target,
      phase: pending.phase,
      archivedAt: pending.archivedAt ?? null,
      markAgentArchived: async (archivedAt) => {
        pending = await this.updateReceipt(scopedKey, {
          ...pending,
          phase: "agent_archived",
          archivedAt,
        });
      },
    });

    if (pending.phase !== "agent_archived" || !pending.archivedAt) {
      throw new Error(
        `Finish request for agent ${pending.target.agentId} completed without a durable archive checkpoint`,
      );
    }
    pending = await this.updateReceipt(scopedKey, { ...pending, state: "succeeded" });
    return outcomeFromReceipt(pending);
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
        `Finish idempotency receipt file exceeds ${this.maxFileBytes} bytes; file was preserved`,
      );
    }
    const parsed = FinishAgentRequestReceiptFileSchema.parse(JSON.parse(raw));
    const now = this.now().getTime();
    for (const receipt of parsed.receipts) {
      if (Date.parse(receipt.updatedAt) > now) {
        throw new Error("Finish idempotency receipt has a future timestamp; file was preserved");
      }
      const scopedKey = fingerprintIdentity(receipt);
      if (this.receipts.has(scopedKey)) {
        throw new Error("Finish idempotency receipt file contains a duplicate scoped key");
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
    receipt: FinishAgentRequestReceipt,
  ): Promise<FinishAgentRequestReceipt> {
    const updated = { ...receipt, updatedAt: this.now().toISOString() };
    FinishAgentRequestReceiptSchema.parse(updated);
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
            version: 1 as const,
            receipts: Array.from(this.receipts.values()),
          };
          const serialized = JSON.stringify(snapshot, null, 2);
          if (Buffer.byteLength(serialized) > this.maxFileBytes) {
            throw new Error(
              `Finish idempotency receipt file limit of ${this.maxFileBytes} bytes was reached`,
            );
          }
          await this.writeReceiptFile(this.filePath, snapshot);
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

function outcomeFromReceipt(receipt: FinishAgentRequestReceipt): FinishAgentOutcome {
  if (!receipt.archivedAt) {
    throw new Error(
      `Finish receipt for agent ${receipt.target.agentId} is missing its archive timestamp`,
    );
  }
  let worktree: FinishAgentWorktreeOutcome = "not_paseo_owned";
  if (receipt.target.worktreePath) {
    worktree = "released";
  } else if (receipt.target.keepWorktree) {
    worktree = "kept";
  }
  return {
    agentId: receipt.target.agentId,
    archivedAt: receipt.archivedAt,
    worktree,
  };
}

function fingerprintIdentity(identity: FinishAgentRequestIdentity): string {
  return createHash("sha256")
    .update(`${identity.daemonId}\0${identity.callerId}\0${identity.action}\0${identity.key}`)
    .digest("hex");
}
