import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients, type TestAgentSession } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const CREATED_AT = "2026-06-29T11:12:42.000Z";
const HEALTHY_UPDATED_AT = "2026-06-29T11:40:00.000Z";
const ORPHAN_ARCHIVED_AT = "2026-06-29T11:35:35.000Z";

interface StaleAgentFixture {
  healthyProjectId: string;
  healthyWorkspaceId: string;
  orphanWorkspaceId: string;
  healthyAgentId: string;
  orphanAgentId: string;
  paseoHomeRoot: string;
  cleanupPaths: string[];
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

test("agent fetch RPCs tolerate an agent whose workspace project record is gone", async () => {
  const fixture = seedStaleAgentFixture();
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  try {
    daemon = await createTestPaseoDaemon({ paseoHomeRoot: fixture.paseoHomeRoot, cleanup: false });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    const agents = await client.fetchAgents({
      requestId: "req-agent-rpc-list",
      filter: { includeArchived: true },
    });
    const history = await client.fetchAgentHistory({
      requestId: "req-agent-rpc-history",
    });
    const orphanAgent = await client.fetchAgent({
      requestId: "req-agent-rpc-detail",
      agentId: fixture.orphanAgentId,
    });

    expect(agents.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(agents.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect(history.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(history.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect({
      agentId: orphanAgent?.agent.id,
      workspaceId: orphanAgent?.agent.workspaceId,
      archivedAt: orphanAgent?.agent.archivedAt,
      project: orphanAgent?.project,
    }).toEqual({
      agentId: fixture.orphanAgentId,
      workspaceId: fixture.orphanWorkspaceId,
      archivedAt: ORPHAN_ARCHIVED_AT,
      project: null,
    });
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("persisted-running agent stays controllable while restart requests load it concurrently", async () => {
  const fixture = seedStaleAgentFixture({ healthyLastStatus: "running", resumable: true });
  const initializationEntered = deferred();
  const releaseInitialization = deferred();
  let resumedSessionCount = 0;
  let interruptCount = 0;
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  const agentClients = createTestAgentClients({
    onSessionCreated(session) {
      resumedSessionCount += 1;
      holdSessionInitialization(session, initializationEntered, releaseInitialization);
      acknowledgeInterrupt(session, () => {
        interruptCount += 1;
      });
    },
  });

  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: fixture.paseoHomeRoot,
      cleanup: false,
      agentClients,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    const before = await client.fetchAgents({ requestId: "req-persisted-running-list" });
    expect(findAgentStatus(before.entries, fixture.healthyAgentId)).toBe("running");

    const finishPromise = client.waitForFinish(fixture.healthyAgentId, 5_000);
    await initializationEntered.promise;
    const timelinePromise = client.fetchAgentTimeline(fixture.healthyAgentId, {
      requestId: "req-persisted-running-timeline",
    });
    const cancelPromise = client.cancelAgent(fixture.healthyAgentId);
    releaseInitialization.resolve();

    const [finish, cancelOutcome] = await Promise.all([
      finishPromise,
      cancelPromise,
      timelinePromise,
    ]);

    expect(cancelOutcome).toBe("cancelled");
    expect(finish.status).toBe("idle");
    expect(finish.final?.status).toBe("idle");
    expect(resumedSessionCount).toBe(1);
    expect(interruptCount).toBe(1);

    const after = await client.fetchAgents({ requestId: "req-persisted-running-after" });
    expect(findAgentStatus(after.entries, fixture.healthyAgentId)).toBe("idle");
  } finally {
    releaseInitialization.resolve();
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function seedStaleAgentFixture(options?: {
  healthyLastStatus?: "idle" | "running";
  resumable?: boolean;
}): StaleAgentFixture {
  const healthyCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-healthy-agent-"));
  const orphanCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-"));
  const paseoHomeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const projectsDir = path.join(paseoHome, "projects");
  const agentsDir = path.join(paseoHome, "agents");
  const healthyProjectId = "proj-healthy-agent-rpc";
  const healthyWorkspaceId = "ws-healthy-agent-rpc";
  const orphanWorkspaceId = "c:\\Users\\paseo\\stale-project";
  const orphanProjectId = "proj-removed-agent-rpc";
  const healthyAgentId = "00000000-0000-4000-8000-000000000401";
  const orphanAgentId = "agent-orphan-rpc";

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeJson(path.join(projectsDir, "projects.json"), [
    {
      projectId: healthyProjectId,
      rootPath: healthyCwd,
      kind: "non_git",
      displayName: "healthy",
      customName: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(projectsDir, "workspaces.json"), [
    {
      workspaceId: healthyWorkspaceId,
      projectId: healthyProjectId,
      cwd: healthyCwd,
      kind: "directory",
      displayName: "healthy",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
    {
      workspaceId: orphanWorkspaceId,
      projectId: orphanProjectId,
      cwd: orphanCwd,
      kind: "directory",
      displayName: "stale project",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: ORPHAN_ARCHIVED_AT,
      archivedAt: ORPHAN_ARCHIVED_AT,
    },
  ]);
  writeJson(path.join(agentsDir, `${healthyAgentId}.json`), {
    id: healthyAgentId,
    provider: "codex",
    cwd: healthyCwd,
    workspaceId: healthyWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: HEALTHY_UPDATED_AT,
    lastActivityAt: HEALTHY_UPDATED_AT,
    lastUserMessageAt: null,
    title: "Healthy Agent",
    labels: {},
    lastStatus: options?.healthyLastStatus ?? "idle",
    lastModeId: "full-access",
    config: null,
    persistence: options?.resumable
      ? { provider: "codex", sessionId: "provider-session-persisted-running" }
      : null,
  });
  writeJson(path.join(agentsDir, `${orphanAgentId}.json`), {
    id: orphanAgentId,
    provider: "codex",
    cwd: orphanCwd,
    workspaceId: orphanWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: ORPHAN_ARCHIVED_AT,
    lastActivityAt: ORPHAN_ARCHIVED_AT,
    lastUserMessageAt: null,
    title: "Orphaned Archived Agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "full-access",
    config: null,
    persistence: null,
    archivedAt: ORPHAN_ARCHIVED_AT,
  });

  return {
    healthyProjectId,
    healthyWorkspaceId,
    orphanWorkspaceId,
    healthyAgentId,
    orphanAgentId,
    paseoHomeRoot,
    cleanupPaths: [healthyCwd, orphanCwd, paseoHomeRoot],
  };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function holdSessionInitialization(
  session: TestAgentSession,
  entered: Deferred,
  release: Deferred,
): void {
  const getAvailableModes = session.getAvailableModes.bind(session);
  session.getAvailableModes = async () => {
    entered.resolve();
    await release.promise;
    return await getAvailableModes();
  };
}

function acknowledgeInterrupt(session: TestAgentSession, onInterrupt: () => void): void {
  const interrupt = session.interrupt.bind(session);
  session.interrupt = async () => {
    onInterrupt();
    await interrupt();
    session.emit({
      type: "turn_canceled",
      provider: "codex",
      reason: "interrupted",
    });
  };
}

function findAgentStatus(
  entries: Array<{ agent: { id: string; status: string } }>,
  agentId: string,
): string | undefined {
  return entries.find((entry) => entry.agent.id === agentId)?.agent.status;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface AgentDirectoryEntrySummaryInput {
  agent: {
    id: string;
    workspaceId?: string;
    archivedAt?: string | null;
  };
  project: {
    projectKey: string;
    projectName: string;
    workspaceName?: string | null;
  };
}

function healthyAgentSummary(fixture: StaleAgentFixture) {
  return {
    agentId: fixture.healthyAgentId,
    workspaceId: fixture.healthyWorkspaceId,
    archivedAt: null,
    projectKey: fixture.healthyProjectId,
    projectName: "healthy",
    workspaceName: "healthy",
  };
}

function toAgentEntrySummary(entry: AgentDirectoryEntrySummaryInput) {
  return {
    agentId: entry.agent.id,
    workspaceId: entry.agent.workspaceId,
    archivedAt: entry.agent.archivedAt ?? null,
    projectKey: entry.project.projectKey,
    projectName: entry.project.projectName,
    workspaceName: entry.project.workspaceName ?? null,
  };
}
