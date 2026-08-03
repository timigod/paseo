import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToDaemon: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: mocks.connectToDaemon,
  getDaemonHost: () => "127.0.0.1:6767",
}));

import { runAgentRunIntent, runRunCommand, type AgentRunIntent } from "./run.js";

const originalAgentId = process.env.PASEO_AGENT_ID;
const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

afterEach(() => {
  if (originalAgentId === undefined) {
    delete process.env.PASEO_AGENT_ID;
  } else {
    process.env.PASEO_AGENT_ID = originalAgentId;
  }
  if (originalWorkspaceId === undefined) {
    delete process.env.PASEO_WORKSPACE_ID;
  } else {
    process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
  }
  vi.clearAllMocks();
});

describe("run create idempotency", () => {
  it("passes the normalized stable key to the daemon create request", async () => {
    process.env.PASEO_AGENT_ID = "parent-agent";
    const createAgent = vi.fn().mockResolvedValue({
      id: "agent-1",
      status: "running",
      provider: "codex",
      cwd: "/tmp/project",
      title: null,
    });
    mocks.connectToDaemon.mockResolvedValue({
      createAgent,
      close: vi.fn().mockResolvedValue(undefined),
    });

    await runRunCommand(
      "repair the fleet",
      {
        background: true,
        cwd: "/tmp/project",
        provider: "codex",
        idempotencyKey: "  fleet-create-1  ",
      },
      {} as Parameters<typeof runRunCommand>[2],
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        callerAgentId: "parent-agent",
        idempotencyKey: "fleet-create-1",
        initialPrompt: "repair the fleet",
      }),
    );
  });

  it("defers new workspace creation to the keyed daemon request", async () => {
    delete process.env.PASEO_AGENT_ID;
    delete process.env.PASEO_WORKSPACE_ID;
    const createAgent = vi.fn().mockResolvedValue({
      id: "agent-1",
      status: "running",
      provider: "codex",
      cwd: "/tmp/project",
      title: null,
    });
    const createWorkspace = vi.fn();
    mocks.connectToDaemon.mockResolvedValue({
      createAgent,
      createWorkspace,
      getLastServerInfoMessage: () => ({ status: "server_info", serverId: "daemon-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await runRunCommand(
      "repair the fleet",
      {
        background: true,
        cwd: "/tmp/project",
        provider: "codex",
        idempotencyKey: "fleet-create-1",
      },
      {} as Parameters<typeof runRunCommand>[2],
    );

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "fleet-create-1",
        workspaceSource: {
          kind: "directory",
          path: "/tmp/project",
        },
      }),
    );
  });

  it("rejects an endpoint remapped to a different daemon before creating", async () => {
    const createAgent = vi.fn();
    mocks.connectToDaemon.mockResolvedValue({
      createAgent,
      getLastServerInfoMessage: () => ({ status: "server_info", serverId: "daemon-b" }),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const intent: AgentRunIntent = {
      create: {
        type: "create_agent_request",
        config: { provider: "codex", cwd: "/tmp/project", model: "gpt-5.4" },
        initialPrompt: "repair the fleet",
        idempotencyKey: "fleet-create-1",
        workspaceSource: { kind: "directory", path: "/tmp/project" },
        labels: {},
      },
      prompt: "repair the fleet",
      waitTimeoutMs: 0,
      background: true,
    };

    await expect(
      runAgentRunIntent({
        intent,
        host: "builder-a.internal:7777",
        expectedDaemonId: "daemon-a",
        idempotencyKey: "fleet-create-1",
      }),
    ).rejects.toMatchObject({
      code: "FLEET_DAEMON_IDENTITY_MISMATCH",
      message: expect.stringContaining("daemon-b"),
    });
    expect(mocks.connectToDaemon).toHaveBeenCalledWith({ host: "builder-a.internal:7777" });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the daemon does not provide a stable identity", async () => {
    const createAgent = vi.fn();
    mocks.connectToDaemon.mockResolvedValue({
      createAgent,
      getLastServerInfoMessage: () => null,
      close: vi.fn().mockResolvedValue(undefined),
    });
    const intent: AgentRunIntent = {
      create: {
        type: "create_agent_request",
        config: { provider: "codex", cwd: "/tmp/project" },
        initialPrompt: "repair the fleet",
        workspaceSource: { kind: "directory", path: "/tmp/project" },
        labels: {},
      },
      prompt: "repair the fleet",
      waitTimeoutMs: 0,
      background: true,
    };

    await expect(
      runAgentRunIntent({
        intent,
        host: "builder-a.internal:7777",
        expectedDaemonId: "daemon-a",
        idempotencyKey: "fleet-create-1",
      }),
    ).rejects.toMatchObject({ code: "FLEET_DAEMON_IDENTITY_UNAVAILABLE" });
    expect(createAgent).not.toHaveBeenCalled();
  });
});
