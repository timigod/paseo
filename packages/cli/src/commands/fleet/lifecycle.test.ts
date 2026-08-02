import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { findFleetAgentMatches, selectFleetAgentLocation } from "./lifecycle.js";
import type { FleetHost } from "./topology.js";

const builderA: FleetHost = {
  id: "builder-a",
  name: "Builder A",
  endpoint: "builder-a.internal:6767",
  codeRoot: "/srv/code",
  hostnamePrefixes: ["builder-a"],
  capacity: 8,
};
const builderB: FleetHost = {
  id: "builder-b",
  name: "Builder B",
  endpoint: "builder-b.internal:6767",
  codeRoot: "/opt/code",
  hostnamePrefixes: ["builder-b"],
  capacity: 12,
};

describe("fleet lifecycle lookup", () => {
  it("selects the one proved agent owner", () => {
    expect(
      selectFleetAgentLocation(
        "agent-1",
        [{ host: builderB, agentId: "agent-123456", archived: false }],
        [],
      ),
    ).toEqual({ host: builderB, agentId: "agent-123456", archived: false });
  });

  it("does not guess across ambiguous or incomplete fleet inventory", () => {
    expect(() =>
      selectFleetAgentLocation(
        "agent",
        [
          { host: builderA, agentId: "agent-111", archived: false },
          { host: builderB, agentId: "agent-222", archived: false },
        ],
        [],
      ),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_AMBIGUOUS" }));
    expect(() =>
      selectFleetAgentLocation("agent", [], [{ host: builderB, error: "connection failed" }]),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_LOOKUP_INCOMPLETE" }));
  });

  it("returns all local prefix matches but prefers an exact id", () => {
    const agents = [
      { id: "agent", title: "Task" },
      { id: "agent-extended", title: "Task" },
    ] as AgentSnapshotPayload[];

    expect(findFleetAgentMatches("agent", builderA, agents)).toEqual([
      { host: builderA, agentId: "agent", archived: false },
    ]);
    expect(findFleetAgentMatches("Task", builderA, agents)).toHaveLength(2);
  });
});
