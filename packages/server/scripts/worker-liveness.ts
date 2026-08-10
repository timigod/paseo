export type WorkerLivenessPhase = "recovering" | "ready";

export type WorkerLivenessTimeoutReason = "worker_recovery_timeout" | "worker_heartbeat_timeout";

export interface WorkerLivenessClock {
  now(): number;
}

export interface WorkerLivenessOptions {
  clock?: WorkerLivenessClock;
  heartbeatTimeoutMs?: number;
  recoveryTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 60_000;

const systemClock: WorkerLivenessClock = {
  now: () => Date.now(),
};

export class WorkerLiveness {
  private readonly clock: WorkerLivenessClock;
  private readonly heartbeatTimeoutMs: number;
  private readonly recoveryTimeoutMs: number;
  private phase: WorkerLivenessPhase = "recovering";
  private recoveryStartedAt: number;
  private lastWorkerHeartbeatAt: number;

  constructor(options: WorkerLivenessOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
    const now = this.clock.now();
    this.recoveryStartedAt = now;
    this.lastWorkerHeartbeatAt = now;
  }

  recordHeartbeat(): void {
    this.lastWorkerHeartbeatAt = this.clock.now();
  }

  markReady(): void {
    this.phase = "ready";
    // A heartbeat observed during recovery must not make a newly-ready worker
    // look stale before it has had a chance to run in the ready phase.
    this.lastWorkerHeartbeatAt = this.clock.now();
  }

  getPhase(): WorkerLivenessPhase {
    return this.phase;
  }

  getExpiredReason(): { reason: WorkerLivenessTimeoutReason; ageMs: number } | null {
    const now = this.clock.now();
    if (this.phase === "recovering") {
      const ageMs = now - this.recoveryStartedAt;
      return ageMs >= this.recoveryTimeoutMs ? { reason: "worker_recovery_timeout", ageMs } : null;
    }

    const ageMs = now - this.lastWorkerHeartbeatAt;
    return ageMs >= this.heartbeatTimeoutMs ? { reason: "worker_heartbeat_timeout", ageMs } : null;
  }
}
