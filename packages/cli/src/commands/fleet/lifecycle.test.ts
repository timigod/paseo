import { describe, expect, it } from "vitest";
import { selectFleetAgentLocation } from "./lifecycle.js";
import { FLEET_HOSTS } from "./topology.js";

const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;
const imac = FLEET_HOSTS.find((host) => host.id === "imac")!;

describe("fleet lifecycle lookup", () => {
  it("keeps recovery and finish on the host that owns the persisted agent", () => {
    expect(
      selectFleetAgentLocation("agent-1", [{ host: imac, agentId: "agent-123456" }], []),
    ).toEqual({ host: imac, agentId: "agent-123456" });
  });

  it("does not guess when a short reference is ambiguous across hosts", () => {
    expect(() =>
      selectFleetAgentLocation(
        "agent",
        [
          { host: macbook, agentId: "agent-111" },
          { host: imac, agentId: "agent-222" },
        ],
        [],
      ),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_AMBIGUOUS" }));
  });

  it("does not claim an agent is absent when fleet lookup is incomplete", () => {
    expect(() =>
      selectFleetAgentLocation("agent-1", [], [{ host: imac, error: "connection reset" }]),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_LOOKUP_INCOMPLETE" }));
  });
});
