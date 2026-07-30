import type { AgentManager } from "./agent-manager.js";

const CAPACITY_STATUSES = new Set(["initializing", "running", "idle"]);

export interface AgentCapacityGate {
  acquire(): () => void;
}

export function createAgentCapacityGate(
  agentManager: Pick<AgentManager, "listAgents">,
  maxActiveAgents: number | undefined,
): AgentCapacityGate | undefined {
  if (maxActiveAgents === undefined) {
    return undefined;
  }

  let reservations = 0;
  return {
    acquire(): () => void {
      const activeAgents = agentManager
        .listAgents()
        .filter((agent) => CAPACITY_STATUSES.has(agent.lifecycle)).length;
      if (activeAgents + reservations >= maxActiveAgents) {
        throw new Error(
          `Agent capacity reached (${
            activeAgents + reservations
          }/${maxActiveAgents}); finish completed agents or wait for active work before creating another`,
        );
      }

      reservations += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reservations -= 1;
      };
    },
  };
}
