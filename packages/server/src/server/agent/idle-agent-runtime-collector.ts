import type { Logger } from "pino";

import type { IdleAgentCollectionResult } from "./agent-manager.js";

export const IDLE_AGENT_RUNTIME_TTL_MS = 2 * 60 * 1000;
export const IDLE_AGENT_RUNTIME_SWEEP_INTERVAL_MS = 15 * 1000;

export interface IdleAgentRuntimeCollectionManager {
  collectIdleAgents(options: {
    cutoff: Date;
    protectedAgentIds: ReadonlySet<string>;
  }): Promise<IdleAgentCollectionResult>;
}

export interface IdleAgentRuntimeScheduleProtection {
  listActiveAgentTargetIds(): Promise<Set<string>>;
}

export interface IdleAgentRuntimeCollectorOptions {
  agentManager: IdleAgentRuntimeCollectionManager;
  scheduleService: IdleAgentRuntimeScheduleProtection;
  logger: Logger;
  now?: () => number;
  ttlMs?: number;
  intervalMs?: number;
}

/**
 * Owns only the daemon timer. AgentManager owns the atomic eligibility check
 * and close barrier so a timer tick cannot race a prompt into a stale runtime.
 */
export class IdleAgentRuntimeCollector {
  private readonly agentManager: IdleAgentRuntimeCollectionManager;
  private readonly scheduleService: IdleAgentRuntimeScheduleProtection;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;

  constructor(options: IdleAgentRuntimeCollectorOptions) {
    this.agentManager = options.agentManager;
    this.scheduleService = options.scheduleService;
    this.logger = options.logger.child({ module: "idle-agent-runtime-collector" });
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? IDLE_AGENT_RUNTIME_TTL_MS;
    this.intervalMs = options.intervalMs ?? IDLE_AGENT_RUNTIME_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.triggerCollection();
    }, this.intervalMs);
    this.timer.unref();
    void this.triggerCollection();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private triggerCollection(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const collection = this.collectOnce()
      .catch((error) => {
        this.logger.warn({ err: error }, "Idle agent runtime sweep failed");
      })
      .finally(() => {
        if (this.inFlight === collection) {
          this.inFlight = null;
        }
      });
    this.inFlight = collection;
    return collection;
  }

  private async collectOnce(): Promise<void> {
    const protectedAgentIds = await this.scheduleService.listActiveAgentTargetIds();
    const cutoff = new Date(this.now() - this.ttlMs);
    const result = await this.agentManager.collectIdleAgents({ cutoff, protectedAgentIds });

    for (const collected of result.collected) {
      this.logger.info(collected, "Collected idle agent runtime");
    }
    for (const failure of result.failures) {
      const { error, ...context } = failure;
      this.logger.warn({ ...context, err: error }, "Failed to collect idle agent runtime");
    }
  }
}
