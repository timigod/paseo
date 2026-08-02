import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeRunErrorWithWorkspaceReceipt,
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  resolveRunWorkspace,
  rollbackDefiniteLegacyRunWorkspace,
  runRunCommand,
  type AgentRunOptions,
} from "./run";
import { DaemonRpcError } from "@getpaseo/client/internal/daemon-client";

describe("atomic run workspace resolution", () => {
  it("defers new workspace creation to a modern daemon", async () => {
    const createWorkspace = vi.fn();
    const client = {
      createWorkspace,
      getLastServerInfoMessage: () => ({ features: { createAgentIdempotency: true } }),
    };

    await expect(resolveRunWorkspace(client as never, {}, "/tmp/project")).resolves.toEqual({
      cwd: "/tmp/project",
      source: { kind: "directory", path: "/tmp/project" },
    });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the two-step workspace path for an older daemon", async () => {
    const createWorkspace = vi.fn(async () => ({
      workspace: {
        id: "workspace-legacy",
        name: "project",
        workspaceDirectory: "/tmp/project",
      },
      error: null,
    }));
    const client = {
      createWorkspace,
      getLastServerInfoMessage: () => ({ features: {} }),
    };

    await expect(resolveRunWorkspace(client as never, {}, "/tmp/project")).resolves.toEqual({
      id: "workspace-legacy",
      cwd: "/tmp/project",
    });
    expect(createWorkspace).toHaveBeenCalledOnce();
  });
});

describe("failed run receipts", () => {
  const atomicIntent = {
    create: {
      type: "create_agent_request" as const,
      config: { provider: "opencode", cwd: "/tmp/project" },
      workspaceSource: { kind: "directory" as const, path: "/tmp/project" },
      initialPrompt: "implement",
      labels: {},
    },
    prompt: "implement",
    waitTimeoutMs: 0,
    background: true,
  };

  it("reports an ambiguous atomic transport outcome without claiming failure", () => {
    expect(
      normalizeRunErrorWithWorkspaceReceipt(new Error("connection reset"), atomicIntent, {}),
    ).toMatchObject({
      code: "AGENT_CREATE_OUTCOME_UNKNOWN",
      details: expect.stringContaining("Inspect the agent and workspace lists"),
    });
  });

  it("keeps a definite daemon rejection distinct from an ambiguous transport failure", () => {
    const rejection = new DaemonRpcError({
      requestId: "request-1",
      requestType: "create_agent_request",
      error: "Invalid mode",
      code: "agent_create_failed",
    });
    expect(normalizeRunErrorWithWorkspaceReceipt(rejection, atomicIntent, {})).toBe(rejection);
  });

  it("reports the exact legacy workspace preserved after an ambiguous failure", () => {
    const legacyIntent = {
      ...atomicIntent,
      create: {
        ...atomicIntent.create,
        workspaceId: "workspace-legacy",
        workspaceSource: undefined,
      },
    };
    expect(
      normalizeRunErrorWithWorkspaceReceipt(new Error("connection reset"), legacyIntent, {}),
    ).toMatchObject({
      code: "AGENT_CREATE_FAILED_WORKSPACE_PRESERVED",
      details: expect.stringContaining("--workspace workspace-legacy"),
    });
  });

  it("archives only the exact legacy workspace after a definite rejection", async () => {
    const archiveWorkspace = vi.fn(async () => ({ workspace: null, error: null }));
    await expect(
      rollbackDefiniteLegacyRunWorkspace({ archiveWorkspace } as never, "workspace-legacy"),
    ).resolves.toBe(true);
    expect(archiveWorkspace).toHaveBeenCalledWith("workspace-legacy");
  });

  it("preserves the legacy workspace when cleanup itself is not confirmed", async () => {
    const archiveWorkspace = vi.fn(async () => ({ workspace: null, error: "connection reset" }));
    await expect(
      rollbackDefiniteLegacyRunWorkspace({ archiveWorkspace } as never, "workspace-legacy"),
    ).resolves.toBe(false);
  });
});

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { newWorkspace: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects a blank create idempotency key before connecting", async () => {
    await expectInvalidOptions({ idempotencyKey: "   " }, /--idempotency-key/);
  });

  it("rejects a create idempotency key longer than 200 characters", async () => {
    await expectInvalidOptions({ idempotencyKey: "x".repeat(201) }, /--idempotency-key/);
  });

  it("rejects a create idempotency key outside the daemon-supported character set", async () => {
    await expectInvalidOptions({ idempotencyKey: "fleet key!" }, /--idempotency-key/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});
