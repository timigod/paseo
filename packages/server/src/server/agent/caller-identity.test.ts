import pino from "pino";
import { describe, expect, test } from "vitest";

import { AgentManager } from "./agent-manager.js";

describe("agent caller identity proof", () => {
  test("binds a daemon-issued proof to one agent id", () => {
    const manager = new AgentManager({
      callerIdentitySecret: "daemon-caller-secret",
      logger: pino({ level: "silent" }),
    });
    const proof = manager.createCallerAgentProof("agent-1");

    expect(proof).toEqual(expect.any(String));
    expect(manager.verifyCallerAgentProof("agent-1", proof ?? undefined)).toBe(true);
    expect(manager.verifyCallerAgentProof("agent-2", proof ?? undefined)).toBe(false);
    expect(manager.verifyCallerAgentProof("agent-1", "forged-proof")).toBe(false);
    expect(manager.verifyCallerAgentProof("agent-1", undefined)).toBe(false);
  });
});
