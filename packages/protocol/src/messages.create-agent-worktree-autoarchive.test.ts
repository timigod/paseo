import { describe, expect, test } from "vitest";

import { ServerInfoStatusPayloadSchema, SessionInboundMessageSchema } from "./messages.js";

describe("create_agent_request worktree and autoArchive fields", () => {
  test("accepts deferred workspace source intent", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create-agent-workspace",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      workspaceSource: {
        kind: "worktree",
        cwd: "/repo/app",
        action: "branch-off",
        branchName: "repair-fleet",
      },
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        workspaceSource: {
          kind: "worktree",
          cwd: "/repo/app",
          action: "branch-off",
          branchName: "repair-fleet",
        },
      }),
    );
  });

  test("accepts optional worktree branch-off target and autoArchive", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create-agent-worktree",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
      },
      autoArchive: true,
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "create-agent-worktree",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
      },
      autoArchive: true,
      labels: {},
    });
  });

  test("keeps legacy create_agent_request defaults unchanged", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      labels: {},
    });
  });

  test("keeps the retry-safe creation capability optional for older daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "older-daemon",
        features: {},
      }).features?.createAgentIdempotency,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "current-daemon",
        features: { createAgentIdempotency: true },
      }).features?.createAgentIdempotency,
    ).toBe(true);
  });
});
