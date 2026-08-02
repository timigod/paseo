import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensurePrivateFile } from "../private-files.js";

export const CREATE_AGENT_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

const CreateAgentRequestReceiptSchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  agentId: z.string(),
  state: z.enum(["pending", "succeeded", "failed"]),
  updatedAt: z.string(),
});

const CreateAgentRequestReceiptFileSchema = z.object({
  version: z.literal(1),
  receipts: z.array(CreateAgentRequestReceiptSchema),
});

type CreateAgentRequestReceipt = z.infer<typeof CreateAgentRequestReceiptSchema>;

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
  hasAgent: (agentId: string) => Promise<boolean>;
  now?: () => Date;
  idFactory?: () => string;
  retentionMs?: number;
}

interface RunCreateAgentRequestInput {
  key: string;
  fingerprint: string;
  create: (agentId: string) => Promise<void>;
}

interface InflightCreateAgentRequest {
  fingerprint: string;
  promise: Promise<string>;
}

export class CreateAgentRequestStore {
  private readonly filePath: string;
  private readonly hasAgent: (agentId: string) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly retentionMs: number;
  private readonly receipts = new Map<string, CreateAgentRequestReceipt>();
  private readonly inflight = new Map<string, InflightCreateAgentRequest>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: CreateAgentRequestStoreOptions) {
    this.filePath = path.join(options.paseoHome, "create-agent-requests.json");
    this.hasAgent = options.hasAgent;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.retentionMs = options.retentionMs ?? CREATE_AGENT_REQUEST_RETENTION_MS;
  }

  async run(input: RunCreateAgentRequestInput): Promise<string> {
    await this.load();
    this.pruneExpiredReceipts();

    const inflight = this.inflight.get(input.key);
    if (inflight) {
      if (inflight.fingerprint !== input.fingerprint) {
        throw new CreateAgentIdempotencyConflictError();
      }
      return inflight.promise;
    }

    const receipt = this.receipts.get(input.key);
    if (receipt && receipt.fingerprint !== input.fingerprint) {
      throw new CreateAgentIdempotencyConflictError();
    }

    const promise = this.execute(input, receipt);
    this.inflight.set(input.key, { fingerprint: input.fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.inflight.get(input.key)?.promise === promise) {
        this.inflight.delete(input.key);
      }
    }
  }

  private async execute(
    input: RunCreateAgentRequestInput,
    existing: CreateAgentRequestReceipt | undefined,
  ): Promise<string> {
    if (existing && (await this.hasAgent(existing.agentId))) {
      if (existing.state !== "succeeded") {
        await this.updateReceipt({ ...existing, state: "succeeded" });
      }
      return existing.agentId;
    }
    if (existing?.state === "failed") {
      throw new Error("The previous create request failed");
    }
    if (existing?.state === "succeeded") {
      throw new Error(
        `Agent ${existing.agentId} from the previous create request no longer exists`,
      );
    }

    const pending: CreateAgentRequestReceipt = existing ?? {
      key: input.key,
      fingerprint: input.fingerprint,
      agentId: this.idFactory(),
      state: "pending",
      updatedAt: this.now().toISOString(),
    };
    await this.updateReceipt(pending);

    try {
      await input.create(pending.agentId);
      await this.updateReceipt({ ...pending, state: "succeeded" });
      return pending.agentId;
    } catch (error) {
      await this.updateReceipt({ ...pending, state: "failed" });
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
    const parsed = CreateAgentRequestReceiptFileSchema.parse(JSON.parse(raw));
    for (const receipt of parsed.receipts) {
      this.receipts.set(receipt.key, receipt);
    }
  }

  private pruneExpiredReceipts(): void {
    const cutoff = this.now().getTime() - this.retentionMs;
    for (const [key, receipt] of this.receipts) {
      if (Date.parse(receipt.updatedAt) < cutoff) {
        this.receipts.delete(key);
      }
    }
  }

  private async updateReceipt(receipt: CreateAgentRequestReceipt): Promise<void> {
    this.receipts.set(receipt.key, { ...receipt, updatedAt: this.now().toISOString() });
    const snapshot = {
      version: 1 as const,
      receipts: Array.from(this.receipts.values()),
    };
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await writeJsonFileAtomic(this.filePath, snapshot);
        ensurePrivateFile(this.filePath);
        return undefined;
      });
    await this.writeQueue;
  }
}
