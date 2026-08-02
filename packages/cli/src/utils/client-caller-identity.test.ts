import { describe, expect, test } from "vitest";

import { resolveCliCallerIdentity } from "./client.js";

describe("CLI caller identity", () => {
  test("binds a provider-launched connection to agent id and incarnation", () => {
    expect(
      resolveCliCallerIdentity({
        PASEO_AGENT_ID: " agent-1 ",
        PASEO_AGENT_INCARNATION: " incarnation-1 ",
      }),
    ).toEqual({ agentId: "agent-1", incarnation: "incarnation-1" });
  });

  test("preserves a partial legacy identity so the daemon can fail closed", () => {
    expect(resolveCliCallerIdentity({ PASEO_AGENT_ID: "agent-1" })).toEqual({
      agentId: "agent-1",
    });
    expect(resolveCliCallerIdentity({})).toBeUndefined();
  });
});
