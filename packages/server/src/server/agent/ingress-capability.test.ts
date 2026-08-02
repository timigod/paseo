import { describe, expect, test } from "vitest";

import { AgentIngressCapabilityAuthority } from "./ingress-capability.js";

describe("AgentIngressCapabilityAuthority", () => {
  test("keeps coordinator and managed-agent authority distinct", () => {
    const authority = new AgentIngressCapabilityAuthority("coordinator-token", Buffer.alloc(32, 7));
    const identity = { agentId: "agent-a", incarnation: "incarnation-a" };

    expect(authority.resolve("coordinator-token")).toEqual({
      kind: "coordinator",
    });
    expect(authority.resolve(authority.issueAgentToken(identity))).toEqual({
      kind: "agent",
      identity,
    });
    expect(authority.resolve(null)).toBeNull();
  });

  test("rejects tampered, malformed, and cross-incarnation agent capabilities", () => {
    const authority = new AgentIngressCapabilityAuthority("coordinator-token", Buffer.alloc(32, 9));
    const token = authority.issueAgentToken({
      agentId: "agent-a",
      incarnation: "incarnation-a",
    });
    const payload = Buffer.from(
      JSON.stringify({ agentId: "agent-a", incarnation: "incarnation-b" }),
      "utf8",
    ).toString("base64url");
    const signature = token.split(".").at(-1);

    expect(authority.resolve(`paseo.agent.v1.${payload}.${signature}`)).toBeNull();
    expect(authority.resolve(`${token}x`)).toBeNull();
    expect(authority.resolve("paseo.agent.v1.invalid.invalid")).toBeNull();
  });
});
