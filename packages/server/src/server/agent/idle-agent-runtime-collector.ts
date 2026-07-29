import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import type { ScheduleService } from "../schedule/service.js";

export const IDLE_AGENT_RUNTIME_TTL_MS = 2 * 60 * 60 * 1000;
export const IDLE_AGENT_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;

type IdleCollectionAgentManager = Pick<AgentManager, "collectIdleAgents">;
type ActiveAgentTargetSource = Pick<ScheduleService, "listActiveAgentTargetIds">;

export interface IdleAgentRuntimeCollectorOptions {
  agentManager: IdleCollectionAgentManager;
  activeAgentTargets: ActiveAgentTargetSource;
  logger: Logger;
  now?: () => Date;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
}

/**
 * Periodically releases eligible idle provider runtimes. The manager owns
 * eligibility and close atomicity; this class owns only timer serialization
 * and shutdown draining.
 */
export class IdleAgentRuntimeCollector {
  private readonly agentManager: IdleCollectionAgentManager;
  private readonly activeAgentTargets: ActiveAgentTargetSource;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(options: IdleAgentRuntimeCollectorOptions) {
    this.agentManager = options.agentManager;
    this.activeAgentTargets = options.activeAgentTargets;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.idleTtlMs = options.idleTtlMs ?? IDLE_AGENT_RUNTIME_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? IDLE_AGENT_RUNTIME_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.sweepIntervalMs);
    this.timer.unref();
  }

  runOnce(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const collection = this.collect()
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private async collect(): Promise<void> {
    const protectedAgentIds = await this.activeAgentTargets.listActiveAgentTargetIds();
    const cutoff = new Date(this.now().getTime() - this.idleTtlMs);
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
