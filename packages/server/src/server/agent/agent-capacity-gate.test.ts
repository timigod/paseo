import { expect, test } from "vitest";

import type { ManagedAgent } from "./agent-manager.js";
import { createAgentCapacityGate } from "./agent-capacity-gate.js";

function agent(lifecycle: ManagedAgent["lifecycle"]): ManagedAgent {
  return { lifecycle } as ManagedAgent;
}

test("leaves agent creation unlimited when no capacity is configured", () => {
  expect(createAgentCapacityGate({ listAgents: () => [] }, undefined)).toBeUndefined();
});

test("counts active agents and concurrent creation reservations atomically", () => {
  const agents = [agent("running"), agent("idle"), agent("closed")];
  const gate = createAgentCapacityGate({ listAgents: () => agents }, 3);
  const release = gate?.acquire();

  expect(() => gate?.acquire()).toThrow("Agent capacity reached (3/3)");

  release?.();
  expect(() => gate?.acquire()).not.toThrow();
});

test("does not double-release a creation reservation", () => {
  const gate = createAgentCapacityGate({ listAgents: () => [] }, 1);
  const release = gate?.acquire();
  release?.();
  release?.();

  const nextRelease = gate?.acquire();
  expect(() => gate?.acquire()).toThrow("Agent capacity reached (1/1)");
  nextRelease?.();
});
