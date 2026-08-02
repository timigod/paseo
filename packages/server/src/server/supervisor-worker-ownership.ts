import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  createSystemManagedProcessTable,
  type ManagedProcessSnapshot,
  type ManagedProcessTable,
} from "./managed-processes/managed-processes.js";

export const SUPERVISOR_WORKER_TOKEN_ENV = "PASEO_SUPERVISOR_WORKER_TOKEN";
export const SUPERVISOR_INCARNATION_ENV = "PASEO_SUPERVISOR_INCARNATION";
export const SUPERVISOR_OWNERSHIP_COMMITTED_MESSAGE = "paseo:ownership-committed";

const WORKER_STATE_FILENAME = "supervisor-worker.json";
const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const CAPTURE_ATTEMPTS = 40;

const WorkerOwnershipStateSchema = z.object({
  version: z.literal(1),
  service: z.object({
    paseoHome: z.string().min(1),
    workerEntry: z.string().min(1),
    desktopManaged: z.boolean(),
  }),
  supervisor: z.object({
    pid: z.number().int().positive(),
    incarnation: z.string().uuid(),
  }),
  worker: z.object({
    pid: z.number().int().positive(),
    commandLine: z.string().min(1),
    startedAt: z.string().min(1),
    token: z.string().uuid(),
  }),
  recordedAt: z.string().datetime(),
});

type WorkerOwnershipState = z.infer<typeof WorkerOwnershipStateSchema>;

export type StaleWorkerRecoveryReceipt =
  | { status: "none" }
  | { status: "cleared-dead"; workerPid: number }
  | { status: "terminated-gracefully"; workerPid: number }
  | { status: "terminated-forcefully"; workerPid: number };

export interface SupervisorWorkerClaim {
  readonly env: NodeJS.ProcessEnv;
  readonly workerPid: number | null;
  commit(workerPid: number): Promise<void>;
  verify(): Promise<boolean>;
  clear(): Promise<void>;
}

interface SupervisorWorkerOwnershipOptions {
  paseoHome: string;
  workerEntry: string;
  desktopManaged: boolean;
  processTable?: ManagedProcessTable;
  platform?: NodeJS.Platform;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  pollIntervalMs?: number;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class SupervisorWorkerOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorWorkerOwnershipError";
  }
}

export class SupervisorWorkerOwnership {
  private readonly statePath: string;
  private readonly service: WorkerOwnershipState["service"];
  private readonly processTable: ManagedProcessTable;
  private readonly platform: NodeJS.Platform;
  private readonly gracefulTimeoutMs: number;
  private readonly forceTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly supervisorIncarnation = randomUUID();

  constructor(options: SupervisorWorkerOwnershipOptions) {
    const paseoHome = path.resolve(options.paseoHome);
    this.statePath = path.join(paseoHome, WORKER_STATE_FILENAME);
    this.service = {
      paseoHome,
      workerEntry: path.resolve(options.workerEntry),
      desktopManaged: options.desktopManaged,
    };
    this.processTable =
      options.processTable ??
      createSystemManagedProcessTable({ identityEnvKey: SUPERVISOR_WORKER_TOKEN_ENV });
    this.platform = options.platform ?? process.platform;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
    this.forceTimeoutMs = options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  createClaim(baseEnv: NodeJS.ProcessEnv): SupervisorWorkerClaim {
    const token = randomUUID();
    let state: WorkerOwnershipState | null = null;

    return {
      env: {
        ...baseEnv,
        [SUPERVISOR_WORKER_TOKEN_ENV]: token,
        [SUPERVISOR_INCARNATION_ENV]: this.supervisorIncarnation,
      },
      get workerPid() {
        return state?.worker.pid ?? null;
      },
      commit: async (workerPid) => {
        const snapshot = await this.captureWorker(workerPid, token);
        state = {
          version: 1,
          service: this.service,
          supervisor: {
            pid: process.pid,
            incarnation: this.supervisorIncarnation,
          },
          worker: {
            pid: workerPid,
            commandLine: snapshot.commandLine as string,
            startedAt: snapshot.startedAt as string,
            token,
          },
          recordedAt: new Date().toISOString(),
        };
        await writeJsonFileAtomic(this.statePath, state);
      },
      verify: async () => {
        if (!state) {
          return false;
        }
        return (await this.inspectOwnedWorker(state)).status === "owned";
      },
      clear: async () => {
        if (!state) {
          return;
        }
        await this.removeStateIfUnchanged(state);
        state = null;
      },
    };
  }

  async recoverStaleWorker(): Promise<StaleWorkerRecoveryReceipt> {
    const state = await this.readState();
    if (!state) {
      return { status: "none" };
    }
    this.assertServiceBoundary(state);

    const initialInspection = await this.inspectOwnedWorker(state);
    if (initialInspection.status === "not-found") {
      await this.removeStateIfUnchanged(state);
      return { status: "cleared-dead", workerPid: state.worker.pid };
    }
    if (initialInspection.status !== "owned") {
      throw this.createIdentityRefusal(state, initialInspection.message);
    }

    await this.signalOwnedWorker(state, "SIGTERM");
    const gracefulResult = await this.waitForOwnedWorkerExit(state, this.gracefulTimeoutMs);
    if (gracefulResult === "exited") {
      await this.removeStateIfUnchanged(state);
      return { status: "terminated-gracefully", workerPid: state.worker.pid };
    }

    await this.signalOwnedWorker(state, "SIGKILL");
    const forceResult = await this.waitForOwnedWorkerExit(state, this.forceTimeoutMs);
    if (forceResult !== "exited") {
      throw new SupervisorWorkerOwnershipError(
        `Owned stale Paseo worker PID ${state.worker.pid} did not exit after SIGKILL. ` +
          `State remains at ${this.statePath}; inspect that PID before retrying.`,
      );
    }

    await this.removeStateIfUnchanged(state);
    return { status: "terminated-forcefully", workerPid: state.worker.pid };
  }

  private async captureWorker(pid: number, token: string): Promise<ManagedProcessSnapshot> {
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      const inspection = await this.processTable.inspect(pid);
      if (inspection.status === "alive") {
        const { snapshot } = inspection;
        const hasBaseIdentity = Boolean(snapshot.commandLine && snapshot.startedAt);
        const tokenMatches = this.platform === "win32" || snapshot.token === token;
        if (hasBaseIdentity && tokenMatches) {
          return snapshot;
        }
      }
      if (attempt < CAPTURE_ATTEMPTS - 1) {
        await this.sleep(this.pollIntervalMs);
      }
    }
    throw new SupervisorWorkerOwnershipError(
      `Could not record identity for Paseo worker PID ${pid}; refusing to let it start without a recoverable ownership record.`,
    );
  }

  private async readState(): Promise<WorkerOwnershipState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw this.createInvalidStateError();
    }
    const result = WorkerOwnershipStateSchema.safeParse(parsed);
    if (!result.success) {
      throw this.createInvalidStateError();
    }
    return result.data;
  }

  private assertServiceBoundary(state: WorkerOwnershipState): void {
    if (
      state.service.paseoHome !== this.service.paseoHome ||
      state.service.workerEntry !== this.service.workerEntry ||
      state.service.desktopManaged !== this.service.desktopManaged
    ) {
      throw new SupervisorWorkerOwnershipError(
        `Refusing to signal stale worker PID ${state.worker.pid}: ${this.statePath} belongs to a different Paseo service or installation. ` +
          "Inspect the recorded process and remove the state file only after confirming it is no longer needed.",
      );
    }
  }

  private async inspectOwnedWorker(
    state: WorkerOwnershipState,
  ): Promise<
    | { status: "owned" }
    | { status: "not-found" }
    | { status: "mismatch" | "unverifiable"; message: string }
  > {
    const inspection = await this.processTable.inspect(state.worker.pid);
    if (inspection.status === "not-found") {
      return { status: "not-found" };
    }
    if (inspection.status === "error") {
      return {
        status: "unverifiable",
        message: `process identity inspection failed (${describeError(inspection.error)})`,
      };
    }

    const snapshot = inspection.snapshot;
    if (snapshot.startedAt !== state.worker.startedAt) {
      return { status: "mismatch", message: "process start time changed (possible PID reuse)" };
    }
    if (this.platform === "win32") {
      return snapshot.commandLine === state.worker.commandLine
        ? { status: "owned" }
        : { status: "mismatch", message: "process command line changed" };
    }
    if (snapshot.token === state.worker.token) {
      return { status: "owned" };
    }
    if (snapshot.token) {
      return { status: "mismatch", message: "worker identity token changed" };
    }
    if (snapshot.commandLine !== state.worker.commandLine) {
      return { status: "mismatch", message: "process command line changed" };
    }
    return { status: "unverifiable", message: "worker identity token is unavailable" };
  }

  private async signalOwnedWorker(
    state: WorkerOwnershipState,
    signal: NodeJS.Signals,
  ): Promise<void> {
    const inspection = await this.inspectOwnedWorker(state);
    if (inspection.status === "not-found") {
      return;
    }
    if (inspection.status !== "owned") {
      throw this.createIdentityRefusal(state, inspection.message);
    }
    try {
      this.signalProcess(state.worker.pid, signal);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ESRCH") {
        return;
      }
      throw new SupervisorWorkerOwnershipError(
        `Failed to send ${signal} to owned stale Paseo worker PID ${state.worker.pid}: ${describeError(error)}`,
      );
    }
  }

  private async waitForOwnedWorkerExit(
    state: WorkerOwnershipState,
    timeoutMs: number,
  ): Promise<"exited" | "timed-out"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const inspection = await this.inspectOwnedWorker(state);
      if (inspection.status === "not-found") {
        return "exited";
      }
      if (inspection.status === "mismatch") {
        return "exited";
      }
      if (inspection.status === "unverifiable") {
        throw this.createIdentityRefusal(state, inspection.message);
      }
      await this.sleep(this.pollIntervalMs);
    }
    return "timed-out";
  }

  private async removeStateIfUnchanged(expected: WorkerOwnershipState): Promise<void> {
    const current = await this.readState();
    if (!current) {
      return;
    }
    if (
      current.supervisor.incarnation !== expected.supervisor.incarnation ||
      current.worker.pid !== expected.worker.pid ||
      current.worker.token !== expected.worker.token
    ) {
      throw new SupervisorWorkerOwnershipError(
        `Worker ownership state changed before cleanup at ${this.statePath}; refusing to remove it.`,
      );
    }
    await fs.unlink(this.statePath);
  }

  private createInvalidStateError(): SupervisorWorkerOwnershipError {
    return new SupervisorWorkerOwnershipError(
      `Invalid stale worker ownership state at ${this.statePath}. Refusing to signal any process; ` +
        "inspect the file and its PID before removing it.",
    );
  }

  private createIdentityRefusal(
    state: WorkerOwnershipState,
    detail: string,
  ): SupervisorWorkerOwnershipError {
    return new SupervisorWorkerOwnershipError(
      `Refusing to signal stale worker PID ${state.worker.pid}: ownership could not be proved because ${detail}. ` +
        `The PID may have been reused. State remains at ${this.statePath} for diagnosis.`,
    );
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
