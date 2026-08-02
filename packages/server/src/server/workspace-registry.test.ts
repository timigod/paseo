import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { promises as fs } from "node:fs";

import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
} from "./workspace-registry.js";
import {
  DestructiveMembershipExcludedError,
  DestructiveMembershipGate,
} from "./destructive-membership-gate.js";

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();
  const allowProjectRemoval = { recheck: () => undefined };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo", allowProjectRemoval);
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("persists cleanup quarantine markers and accepts legacy unmarked cleanup", async () => {
    await workspaceRegistry.initialize();
    const timestamp = "2026-08-01T00:00:00.000Z";
    const marker = "00000000-0000-4000-8000-000000000043";
    for (const [workspaceId, quarantineMarker] of [
      ["workspace-marked-cleanup", marker],
      ["workspace-legacy-cleanup", undefined],
    ] as const) {
      await workspaceRegistry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "project-cleanup",
          cwd: `/tmp/${workspaceId}`,
          kind: "worktree",
          displayName: workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: timestamp,
          cleanupPending: {
            directoryPath: `/tmp/${workspaceId}`,
            teardownCwd: `/tmp/${workspaceId}`,
            mainRepoRoot: "/tmp/repo",
            paseoWorktreesRoot: "/tmp/worktrees",
            worktreeIncarnationId: "incarnation-cleanup",
            quarantineMarker,
          },
        }),
      );
    }

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloaded.initialize();

    expect((await reloaded.get("workspace-marked-cleanup"))?.cleanupPending?.quarantineMarker).toBe(
      marker,
    );
    expect(
      (await reloaded.get("workspace-legacy-cleanup"))?.cleanupPending?.quarantineMarker,
    ).toBeUndefined();
  });

  test("does not remove a project when authority is revoked before rename", async () => {
    await projectRegistry.initialize();
    const project = createPersistedProjectRecord({
      projectId: "project-guarded-remove",
      rootPath: "/tmp/project-guarded-remove",
      kind: "git",
      displayName: "guarded",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await projectRegistry.upsert(project);
    let recheckCount = 0;

    await expect(
      projectRegistry.remove(project.projectId, {
        recheck: () => {
          recheckCount += 1;
          if (recheckCount === 3) {
            throw new Error("project removal authority revoked before rename");
          }
        },
      }),
    ).rejects.toThrow("project removal authority revoked before rename");

    expect(await projectRegistry.get(project.projectId)).toEqual(project);
    const reloaded = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    expect(await reloaded.get(project.projectId)).toEqual(project);
  });

  test("does not remove a project without an explicit commit-time recheck", async () => {
    const project = createPersistedProjectRecord({
      projectId: "project-missing-remove-authority",
      rootPath: "/tmp/project-missing-remove-authority",
      kind: "git",
      displayName: "missing authority",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await projectRegistry.upsert(project);

    await expect(projectRegistry.remove(project.projectId, undefined as never)).rejects.toThrow(
      "Project removal requires a commit-time authority recheck",
    );

    expect(await projectRegistry.get(project.projectId)).toEqual(project);
  });

  test("publishes only project mutations that change the persisted lifecycle", async () => {
    await projectRegistry.initialize();
    const mutations: Array<{
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: ReturnType<typeof createPersistedProjectRecord> | null;
    }> = [];
    const unsubscribe = projectRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    const active = createPersistedProjectRecord({
      projectId: "project-one",
      rootPath: "/tmp/project-one",
      kind: "non_git",
      displayName: "project-one",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const archived = {
      ...active,
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    };

    await projectRegistry.upsert(active);
    await projectRegistry.archive(active.projectId, archived.archivedAt);
    await projectRegistry.archive(active.projectId, "2026-03-03T00:00:00.000Z");
    await projectRegistry.archive("project-unknown", "2026-03-03T00:00:00.000Z");
    await projectRegistry.remove(active.projectId, allowProjectRemoval);
    await projectRegistry.remove(active.projectId, allowProjectRemoval);
    await projectRegistry.remove("project-unknown", allowProjectRemoval);

    expect(mutations).toEqual([
      { kind: "upsert", projectId: active.projectId, project: active },
      { kind: "archive", projectId: active.projectId, project: archived },
      { kind: "remove", projectId: active.projectId, project: null },
    ]);
    unsubscribe();
  });

  test("atomically allocates one opaque project for concurrent exact-root adds", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "same-root");
    const projects = await Promise.all(
      Array.from({ length: 20 }, () =>
        projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: "non_git",
          displayName: "same-root",
          timestamp: "2026-03-01T00:00:00.000Z",
        }),
      ),
    );

    expect(new Set(projects.map((project) => project.projectId))).toEqual(
      new Set([projects[0]!.projectId]),
    );
    expect(projects[0]!.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(await projectRegistry.list()).toHaveLength(1);
  });

  test("keeps readable legacy IDs alongside newly allocated opaque IDs", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/legacy",
        kind: "git",
        displayName: "repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const opaque = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "/tmp/new",
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    expect((await projectRegistry.get("remote:github.com/acme/repo"))?.rootPath).toBe(
      "/tmp/legacy",
    );
    expect(opaque.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("allocates a fresh opaque ID when only an archived exact root exists", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "archived-root");
    const archived = createPersistedProjectRecord({
      projectId: "prj_archived",
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(archived);

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      timestamp: "2026-03-03T00:00:00.000Z",
    });

    expect(created).toMatchObject({ rootPath, archivedAt: null });
    expect(created.projectId).not.toBe(archived.projectId);
    expect(await projectRegistry.get(archived.projectId)).toEqual(archived);
  });

  test("refreshes the oldest active legacy duplicate kind without rewriting its identity", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "legacy-root");
    const oldest = createPersistedProjectRecord({
      projectId: "remote:oldest",
      rootPath,
      kind: "git",
      displayName: "oldest",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const duplicate = createPersistedProjectRecord({
      projectId: "remote:duplicate",
      rootPath,
      kind: "git",
      displayName: "duplicate",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(oldest);
    await projectRegistry.upsert(duplicate);

    await expect(
      projectRegistry.getOrCreateActiveByRoot({
        rootPath,
        kind: "non_git",
        displayName: "new-name",
        timestamp: "2026-03-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...oldest,
      kind: "non_git",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await projectRegistry.list()).toEqual([
      { ...oldest, kind: "non_git", updatedAt: "2026-03-03T00:00:00.000Z" },
      duplicate,
    ]);
  });

  test("reuses an active project for Windows lexical-equivalent root spellings", async () => {
    await projectRegistry.initialize();
    const first = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "C:\\Users\\Paseo\\Repo",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const second = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "c:/users/paseo/repo/.",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(await projectRegistry.list()).toEqual([first]);
  });

  test("keeps lexical and symlink root spellings distinct without realpath", async () => {
    await projectRegistry.initialize();
    const target = path.join(tmpDir, "target");
    const link = path.join(tmpDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const targetProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: target,
      kind: "non_git",
      displayName: "target",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const linkProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: link,
      kind: "non_git",
      displayName: "link",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(linkProject.projectId).not.toBe(targetProject.projectId);
    expect(await projectRegistry.list()).toEqual([targetProject, linkProject]);
  });

  test("retries a generated project ID collision", async () => {
    const generatedIds = ["prj_collision", "prj_fresh"];
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      { projectIdFactory: () => generatedIds.shift() ?? "prj_unexpected" },
    );
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_collision",
        rootPath: path.join(tmpDir, "existing"),
        kind: "non_git",
        displayName: "existing",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: path.join(tmpDir, "new"),
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(created.projectId).toBe("prj_fresh");
    expect(await projectRegistry.list()).toHaveLength(2);
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("refreshes workspace archive timestamps when an archive is repeated", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-one",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-one", "2026-03-02T00:00:00.000Z");
    await workspaceRegistry.archive("workspace-one", "2026-03-03T00:00:00.000Z");

    expect(await workspaceRegistry.get("workspace-one")).toMatchObject({
      archivedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("does not commit a workspace archive when authority is revoked before rename", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-guarded",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    let recheckCount = 0;

    await expect(
      workspaceRegistry.archive("workspace-guarded", "2026-03-03T00:00:00.000Z", {
        recheck: () => {
          recheckCount += 1;
          if (recheckCount === 3) {
            throw new Error("workspace authority revoked before rename");
          }
        },
      }),
    ).rejects.toThrow("workspace authority revoked before rename");

    expect((await workspaceRegistry.get("workspace-guarded"))?.archivedAt).toBeNull();
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect((await reloaded.get("workspace-guarded"))?.archivedAt).toBeNull();
  });

  test("serializes a rejected guarded archive without leaking archivedAt into a queued update", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-concurrent-guard",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    let recheckCount = 0;
    let markTemporaryWriteReached = () => {};
    let releaseTemporaryWrite = () => {};
    const temporaryWriteReached = new Promise<void>((resolve) => {
      markTemporaryWriteReached = resolve;
    });
    const temporaryWriteReleased = new Promise<void>((resolve) => {
      releaseTemporaryWrite = resolve;
    });
    const archive = workspaceRegistry.archive(
      "workspace-concurrent-guard",
      "2026-03-03T00:00:00.000Z",
      {
        recheck: async () => {
          recheckCount += 1;
          if (recheckCount === 3) {
            markTemporaryWriteReached();
            await temporaryWriteReleased;
            throw new Error("workspace archive revoked after temporary write");
          }
        },
      },
    );

    await temporaryWriteReached;
    expect((await workspaceRegistry.get("workspace-concurrent-guard"))?.archivedAt).toBeNull();
    const update = workspaceRegistry.update("workspace-concurrent-guard", (record) => ({
      ...record,
      title: "Concurrent update",
      updatedAt: "2026-03-04T00:00:00.000Z",
    }));
    expect((await workspaceRegistry.get("workspace-concurrent-guard"))?.title).toBeNull();
    releaseTemporaryWrite();

    await expect(archive).rejects.toThrow("workspace archive revoked after temporary write");
    await expect(update).resolves.toMatchObject({
      title: "Concurrent update",
      archivedAt: null,
    });
    expect(await workspaceRegistry.get("workspace-concurrent-guard")).toMatchObject({
      title: "Concurrent update",
      archivedAt: null,
    });
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect(await reloaded.get("workspace-concurrent-guard")).toMatchObject({
      title: "Concurrent update",
      archivedAt: null,
    });
  });

  test("serializes a successful guarded archive before a concurrent update", async () => {
    const workspaceId = "workspace-successful-archive-update";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    let recheckCount = 0;
    let markBeforeRenameReached = () => {};
    let releaseBeforeRename = () => {};
    const beforeRenameReached = new Promise<void>((resolve) => {
      markBeforeRenameReached = resolve;
    });
    const beforeRenameReleased = new Promise<void>((resolve) => {
      releaseBeforeRename = resolve;
    });
    const archive = workspaceRegistry.archive(workspaceId, "2026-03-03T00:00:00.000Z", {
      recheck: async () => {
        recheckCount += 1;
        if (recheckCount === 3) {
          markBeforeRenameReached();
          await beforeRenameReleased;
        }
      },
    });

    await beforeRenameReached;
    const update = workspaceRegistry.update(workspaceId, (record) => ({
      ...record,
      title: "Concurrent",
      updatedAt: "2026-03-04T00:00:00.000Z",
    }));
    expect((await workspaceRegistry.get(workspaceId))?.title).toBeNull();
    releaseBeforeRename();

    await expect(archive).resolves.toBeUndefined();
    await expect(update).resolves.toMatchObject({
      title: "Concurrent",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await workspaceRegistry.get(workspaceId)).toMatchObject({
      title: "Concurrent",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect(await reloaded.get(workspaceId)).toMatchObject({
      title: "Concurrent",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("serializes a successful guarded removal before a queued replacement", async () => {
    const workspaceId = "workspace-successful-remove-upsert";
    const original = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "project-one",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await workspaceRegistry.upsert(original);
    let recheckCount = 0;
    let markBeforeRenameReached = () => {};
    let releaseBeforeRename = () => {};
    const beforeRenameReached = new Promise<void>((resolve) => {
      markBeforeRenameReached = resolve;
    });
    const beforeRenameReleased = new Promise<void>((resolve) => {
      releaseBeforeRename = resolve;
    });
    const removal = workspaceRegistry.remove(workspaceId, {
      recheck: async () => {
        recheckCount += 1;
        if (recheckCount === 3) {
          markBeforeRenameReached();
          await beforeRenameReleased;
        }
      },
    });

    await beforeRenameReached;
    const replacement = {
      ...original,
      title: "Replacement",
      updatedAt: "2026-03-04T00:00:00.000Z",
    };
    const upsert = workspaceRegistry.upsert(replacement);
    expect(await workspaceRegistry.get(workspaceId)).toEqual(original);
    releaseBeforeRename();

    await expect(removal).resolves.toBeUndefined();
    await expect(upsert).resolves.toBeUndefined();
    expect(await workspaceRegistry.get(workspaceId)).toEqual(replacement);
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect(await reloaded.get(workspaceId)).toEqual(replacement);
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("shares a cold load before serializing concurrent workspace updates", async () => {
    const workspaceId = "workspace-cold-concurrent-updates";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const filePath = path.join(tmpDir, "projects", "workspaces.json");
    const coldRegistry = new FileBackedWorkspaceRegistry(filePath, logger);
    const readFile = fs.readFile.bind(fs);
    let readCount = 0;
    let releaseSecondRead = () => {};
    const secondReadReleased = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      readCount += 1;
      const raw = await readFile(...args);
      if (readCount === 2) {
        await secondReadReleased;
      }
      return raw;
    });

    try {
      const titleUpdate = coldRegistry.update(workspaceId, (record) => ({
        ...record,
        title: "Cold title",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }));
      const pinUpdate = coldRegistry.update(workspaceId, (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      }));

      await expect(titleUpdate).resolves.toMatchObject({ title: "Cold title" });
      releaseSecondRead();
      await expect(pinUpdate).resolves.toMatchObject({
        title: "Cold title",
        pinnedAt: "2026-03-03T00:00:00.000Z",
      });
      expect(readCount).toBe(1);
    } finally {
      releaseSecondRead();
      readSpy.mockRestore();
    }

    const reloadedRegistry = new FileBackedWorkspaceRegistry(filePath, logger);
    expect(await reloadedRegistry.get(workspaceId)).toMatchObject({
      title: "Cold title",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("does not advance membership for unrelated workspace metadata", async () => {
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-metadata-only",
        projectId: "project-one",
        cwd: "/tmp/metadata-only",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const membershipVersion = workspaceRegistry.getMembershipVersion();

    await workspaceRegistry.update("workspace-metadata-only", (record) => ({
      ...record,
      title: "Metadata only",
      pinnedAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    }));

    expect(workspaceRegistry.getMembershipVersion()).toBe(membershipVersion);
  });

  test("rejects a workspace registration after its project is durably removed", async () => {
    const membershipGate = new DestructiveMembershipGate();
    const gatedProjectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "gated", "projects.json"),
      logger,
      { membershipGate },
    );
    const gatedWorkspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "gated", "workspaces.json"),
      logger,
      { membershipGate },
    );
    const project = createPersistedProjectRecord({
      projectId: "project-late-workspace",
      rootPath: "/tmp/project-late-workspace",
      kind: "git",
      displayName: "late-workspace",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await gatedProjectRegistry.upsert(project);
    const destructiveLease = await membershipGate.acquireDestructive({
      projectIds: [project.projectId],
      paths: [project.rootPath],
    });

    try {
      await gatedProjectRegistry.remove(project.projectId, { recheck: () => undefined });
      expect(await gatedProjectRegistry.get(project.projectId)).toBeNull();
      await expect(
        gatedWorkspaceRegistry.upsert(
          createPersistedWorkspaceRecord({
            workspaceId: "workspace-too-late",
            projectId: project.projectId,
            cwd: project.rootPath,
            kind: "local_checkout",
            displayName: "main",
            createdAt: "2026-03-02T00:00:00.000Z",
            updatedAt: "2026-03-02T00:00:00.000Z",
          }),
        ),
      ).rejects.toBeInstanceOf(DestructiveMembershipExcludedError);
    } finally {
      destructiveLease.release();
    }
  });
});
