import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DaemonClient, createTestPaseoDaemon } from "./test-utils/index.js";

const SHARED_SECRET_HASH = "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createCwd(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "destructive-authority-e2e-"));
  cleanupPaths.push(cwd);
  return cwd;
}

async function createManagedAgent(
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>,
  cwd: string,
) {
  return daemon.daemon.agentManager.createAgent(
    {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "full-access",
      cwd,
    },
    undefined,
    { workspaceId: undefined },
  );
}

describe("destructive authority over real WebSocket execution paths", () => {
  test("binds agent and coordinator authority to the physical connection", async () => {
    const daemon = await createTestPaseoDaemon({
      auth: { password: SHARED_SECRET_HASH },
    });
    const cwd = createCwd();
    const agentA = await createManagedAgent(daemon, cwd);
    const agentB = await createManagedAgent(daemon, cwd);
    const agentC = await createManagedAgent(daemon, cwd);
    const identity = daemon.daemon.agentManager.getAgentCallerIdentity(agentA.id);
    if (!identity) throw new Error("Expected a current caller incarnation");

    const coordinator = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "coordinator-physical-connection",
      password: "shared-secret",
      reconnect: { enabled: false },
    });
    const agentCaller = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "agent-physical-connection",
      password: "shared-secret",
      callerAgent: identity,
      reconnect: { enabled: false },
    });

    try {
      await Promise.all([coordinator.connect(), agentCaller.connect()]);

      const selfArchive = await agentCaller
        .archiveAgent(agentA.id)
        .catch((error) => error as Error);
      expect(selfArchive).toBeInstanceOf(Error);
      expect((selfArchive as Error).message).toContain("SELF_ARCHIVE_BLOCKED");
      expect((selfArchive as Error).message).not.toContain(agentA.id);
      expect((selfArchive as Error).message).not.toContain(cwd);

      await expect(agentCaller.deleteAgent(agentA.id)).rejects.toThrow(
        "managed agent cannot target itself",
      );
      await expect(agentCaller.closeItems({ agentIds: [agentA.id] })).resolves.toMatchObject({
        agents: [],
      });
      expect(daemon.daemon.agentManager.getAgent(agentA.id)).not.toBeNull();

      await expect(agentCaller.archiveAgent(agentB.id)).resolves.toHaveProperty("archivedAt");
      expect(daemon.daemon.agentManager.getAgent(agentB.id)).toBeNull();

      await daemon.daemon.agentManager.reloadAgentSession(agentA.id);
      const staleReplay = await agentCaller.deleteAgent(agentC.id).catch((error) => error as Error);
      expect(staleReplay).toBeInstanceOf(Error);
      expect((staleReplay as Error).message).toContain("INVALID_CALLER_IDENTITY");
      expect((staleReplay as Error).message).not.toContain(agentC.id);
      expect((staleReplay as Error).message).not.toContain(cwd);

      await expect(coordinator.archiveAgent(agentC.id)).resolves.toHaveProperty("archivedAt");
      expect(daemon.daemon.agentManager.getAgent(agentC.id)).toBeNull();
    } finally {
      await Promise.all([coordinator.close(), agentCaller.close()]);
      await daemon.close();
    }
  });

  test("fails closed for unauthenticated raw and partial legacy callers", async () => {
    const daemon = await createTestPaseoDaemon();
    const cwd = createCwd();
    const target = await createManagedAgent(daemon, cwd);
    const rawClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "raw-legacy-connection",
      clientType: "browser",
      reconnect: { enabled: false },
    });
    const partialAgentClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "partial-agent-connection",
      callerAgent: { agentId: target.id },
      reconnect: { enabled: false },
    });

    try {
      await Promise.all([rawClient.connect(), partialAgentClient.connect()]);
      await expect(rawClient.archiveAgent(target.id)).rejects.toThrow("INVALID_CALLER_IDENTITY");
      await expect(partialAgentClient.deleteAgent(target.id)).rejects.toThrow(
        "INVALID_CALLER_IDENTITY",
      );
      expect(daemon.daemon.agentManager.getAgent(target.id)).not.toBeNull();
    } finally {
      await Promise.all([rawClient.close(), partialAgentClient.close()]);
      await daemon.close();
    }
  });
});
