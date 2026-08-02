import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { findFleetAgentMatches, selectFleetAgentLocation } from "./lifecycle.js";
import { FLEET_HOSTS } from "./topology.js";

const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;
const imac = FLEET_HOSTS.find((host) => host.id === "imac")!;

describe("fleet lifecycle lookup", () => {
  it("selects the one proved agent owner", () => {
    expect(
      selectFleetAgentLocation(
        "agent-1",
        [{ host: imac, agentId: "agent-123456", archived: false }],
        [],
      ),
    ).toEqual({ host: imac, agentId: "agent-123456", archived: false });
  });

  it("does not guess across ambiguous or incomplete fleet inventory", () => {
    expect(() =>
      selectFleetAgentLocation(
        "agent",
        [
          { host: macbook, agentId: "agent-111", archived: false },
          { host: imac, agentId: "agent-222", archived: false },
        ],
        [],
      ),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_AMBIGUOUS" }));
    expect(() =>
      selectFleetAgentLocation("agent", [], [{ host: imac, error: "connection reset" }]),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_LOOKUP_INCOMPLETE" }));
  });

  it("returns all local prefix matches but prefers an exact id", () => {
    const agents = [
      { id: "agent", title: "Task" },
      { id: "agent-extended", title: "Task" },
    ] as AgentSnapshotPayload[];

    expect(findFleetAgentMatches("agent", macbook, agents)).toEqual([
      { host: macbook, agentId: "agent", archived: false },
    ]);
    expect(findFleetAgentMatches("Task", macbook, agents)).toHaveLength(2);
  });
});
