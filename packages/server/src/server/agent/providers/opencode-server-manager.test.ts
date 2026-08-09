import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
} from "../agent-runtime-capacity.js";
import type {
  AgentRuntimeCapacityController,
  AgentRuntimeCapacityReservation,
} from "../agent-sdk-types.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRecordOptions,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
  ManagedProcessVerification,
} from "../../managed-processes/managed-processes.js";
import type {
  ProcessTerminator,
  TerminateWithTreeKillResult,
  TreeKillTarget,
} from "../../../utils/tree-kill.js";
import {
  isDirectOpenCodeWindowsExecutable,
  OpenCodeServerManager,
  type OpenCodeCommandPrefixResolver,
  type OpenCodePortAllocator,
  type OpenCodeServerProcessSpawner,
} from "./opencode/server-manager.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { TestOpenCodeClient } from "./opencode/test-utils/test-opencode-harness.js";

const TEST_OPENCODE_COMMAND = process.platform === "win32" ? "C:\\test\\opencode.exe" : "opencode";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCodeServerManager generations", () => {
  test("uses an explicit base environment for the server process", async () => {
    const baseEnv = { HOME: "/isolated/home", PATH: "/isolated/bin" };
    const { manager, runtime } = createTestManager([4091], { baseEnv });

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls[0]?.options.baseEnv).toEqual(baseEnv);
    await acquisition.release();
  });

  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4101, 4102]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(runtime.terminatedPorts).toEqual([]);

    await newAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4102, 4101]);
  });

  test("new acquisitions after rotation use the new server", async () => {
    const { manager, runtime } = createTestManager([4201, 4202]);

    const oldAcquisition = await manager.acquireCurrent();
    const rotatedAcquisition = await manager.acquireNew();
    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(runtime.terminatedPorts).toEqual([]);

    await rotatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);
    await nextAcquisition.release();
    await oldAcquisition.release();
  });

  test("concurrent new-server acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4251, 4252, 4253]);

    const initialAcquisition = await manager.acquireCurrent();
    await initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquireNew(),
      manager.acquireNew(),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(runtime.launchedPorts).toEqual([4251, 4252]);

    await modesAcquisition.release();
    await modelsAcquisition.release();
  });

  test("concurrent current and new acquisitions keep the starting generation alive", async () => {
    const { manager, runtime } = createTestManager([4254, 4255]);

    const [currentAcquisition, newAcquisition] = await Promise.all([
      manager.acquireCurrent(),
      manager.acquireNew(),
    ]);

    expect(currentAcquisition.server.url).toBe("http://127.0.0.1:4254");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4255");
    expect(runtime.terminatedPorts).toEqual([]);

    await newAcquisition.release();
    await currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4255, 4254]);
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4301, 4302]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();
    await newAcquisition.release();

    await oldAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4302, 4301]);
  });

  test("shutdown kills current and retired servers", async () => {
    const { manager, runtime } = createTestManager([4401, 4402]);

    await manager.acquireCurrent();
    await manager.acquireNew();

    await manager.shutdown();

    expect(new Set(runtime.terminatedPorts)).toEqual(new Set([4401, 4402]));
  });

  test("shutdown still signals a process after an earlier kill signal if it has not exited", async () => {
    const { manager, runtime } = createTestManager([4451]);

    await manager.acquireCurrent();
    runtime.processForPort(4451).markKillSignalSent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4451]);
  });

  test("admits concurrent shared acquisitions and rejects another server generation", async () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const { manager, runtime } = createTestManager([4461, 4462], { autoAnnounce: false });
    manager.configureRuntimeCapacityController(controller);

    const firstStart = manager.acquireCurrent();
    const sharedStart = manager.acquireCurrent();
    await runtime.settle();
    expect(runtime.launchedPorts).toEqual([4461]);

    runtime.processForPort(4461).announceListening();
    const [first, shared] = await Promise.all([firstStart, sharedStart]);

    await expect(manager.acquireDedicated({ PASEO_AGENT_ID: "second" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );
    expect(runtime.launchedPorts).toEqual([4461]);

    await shared.release();
    await first.release();
  });

  test("uses separate serial reservations for executable discovery and the helper server", async () => {
    const controller = new RecordingRuntimeCapacityController(1);
    const { manager } = createTestManager([4462]);
    manager.configureRuntimeCapacityController(controller);

    const acquisition = await manager.acquireCurrent();

    expect(controller.events).toEqual(["reserve", "release", "reserve", "track"]);
    await acquisition.release();
  });

  test("releases capacity after a failed startup is terminated", async () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const { manager, runtime } = createTestManager([4463, 4464], { autoAnnounce: false });
    manager.configureRuntimeCapacityController(controller);

    const failedStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4463).failStartup(new Error("OpenCode failed during startup"));

    await expect(failedStart).rejects.toThrow("OpenCode failed during startup");

    const nextStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4464).announceListening();
    const next = await nextStart;

    expect(runtime.launchedPorts).toEqual([4463, 4464]);
    await next.release();
  });

  test("releases capacity after a normal server stop", async () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const { manager, runtime } = createTestManager([4465, 4466]);
    manager.configureRuntimeCapacityController(controller);

    const first = await manager.acquireCurrent();
    await first.release();
    const second = await manager.acquireCurrent();

    expect(runtime.launchedPorts).toEqual([4465, 4466]);
    await second.release();
  });

  test("retains capacity after kill timeout until a later cleanup confirms termination", async () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const { manager, runtime } = createTestManager([4467, 4468, 4469], {
      terminationResult: "kill-timeout",
    });
    manager.configureRuntimeCapacityController(controller);

    const first = await manager.acquireCurrent();
    await first.release();

    expect(controller.getAvailableRuntimeSlots()).toBe(0);
    await expect(manager.acquireCurrent()).rejects.toThrow("helper cleanup is incomplete");
    expect(runtime.launchedPorts).toEqual([4467]);

    runtime.setTerminationResult("terminated");
    const next = await manager.acquireCurrent();

    expect(runtime.launchedPorts).toEqual([4467, 4468]);
    await next.release();
  });

  test("startup timeout kills the spawned server and removes its managed-process record", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4471], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server startup timeout");
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(30_000);

    await failure;
    expect(runtime.terminatedPorts).toEqual([4471]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("catalog deadline cancels an unowned server startup", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4481], { autoAnnounce: false });
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: manager,
      createClient: () => new TestOpenCodeClient().asSdkClient(),
    });
    let catalogError: unknown;
    const catalog = client
      .fetchCatalog({
        scope: "workspace",
        cwd: "/tmp/opencode-catalog-deadline",
        force: false,
        timeoutMs: 250,
      })
      .catch((error: unknown) => {
        catalogError = error;
      });
    await runtime.settle();

    try {
      await vi.advanceTimersByTimeAsync(250);

      expect(catalogError).toMatchObject({
        message: "OpenCode server acquisition timed out within the 250ms catalog budget",
      });
      expect(runtime.terminatedPorts).toEqual([4481]);
      expect(await runtime.managedProcesses.list()).toEqual([]);
    } finally {
      await manager.shutdown();
      await catalog;
    }
  });

  test("catalog deadline leaves a shared server startup alive", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4482], { autoAnnounce: false });
    const owner = manager.acquireCurrent();
    await runtime.settle();
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: manager,
      createClient: () => new TestOpenCodeClient().asSdkClient(),
    });
    const catalog = client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/opencode-catalog-shared",
      force: false,
      timeoutMs: 250,
    });
    const failure = expect(catalog).rejects.toThrow(
      "OpenCode server acquisition timed out within the 250ms catalog budget",
    );

    await vi.advanceTimersByTimeAsync(250);
    await failure;
    expect(runtime.terminatedPorts).toEqual([]);

    runtime.processForPort(4482).announceListening();
    const acquisition = await owner;
    expect(acquisition.server.url).toBe("http://127.0.0.1:4482");

    await acquisition.release();
    expect(runtime.terminatedPorts).toEqual([4482]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("forced catalog deadline keeps the current server generation", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4483, 4484], { autoAnnounce: false });
    const currentStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4483).announceListening();
    const current = await currentStart;
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: manager,
      createClient: () => new TestOpenCodeClient().asSdkClient(),
    });
    const catalog = client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/opencode-catalog-force",
      force: true,
      timeoutMs: 250,
    });
    const failure = expect(catalog).rejects.toThrow(
      "OpenCode server acquisition timed out within the 250ms catalog budget",
    );
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(250);
    await failure;
    expect(runtime.terminatedPorts).toEqual([4484]);

    const retained = await manager.acquireCurrent();
    expect(retained.server.url).toBe(current.server.url);
    await retained.release();
    await current.release();
    expect(runtime.terminatedPorts).toEqual([4484, 4483]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown kills a server that is still starting", async () => {
    const { manager, runtime } = createTestManager([4472], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();

    await manager.shutdown();

    await expect(acquisition).rejects.toThrow("OpenCode server exited with code null");
    expect(runtime.terminatedPorts).toEqual([4472]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown prevents a pre-spawn start from crossing its barrier", async () => {
    const portAllocationGate = new TestGate();
    const { manager, runtime } = createTestManager([4472], {
      portAllocationGate,
    });

    const acquisition = manager.acquireNew();
    const failure = expect(acquisition).rejects.toThrow(
      "OpenCode server terminated during startup",
    );
    await portAllocationGate.waitUntilReached();

    const shutdown = manager.shutdown();
    await expect(manager.acquireCurrent()).rejects.toThrow("manager is shutting down");
    portAllocationGate.release();

    await shutdown;
    await failure;
    expect(runtime.launchedPorts).toEqual([]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown waits for a spawned server that is awaiting readiness to terminate", async () => {
    const terminationGate = new TestGate();
    const { manager, runtime } = createTestManager([4473], {
      autoAnnounce: false,
      terminationGate,
    });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server exited with code null");
    await runtime.settle();
    expect(runtime.launchedPorts).toEqual([4473]);

    const shutdown = manager.shutdown();
    await terminationGate.waitUntilReached();
    expect(runtime.processForPort(4473).signalCode).toBe(null);
    terminationGate.release();

    await shutdown;
    await failure;
    expect(runtime.terminatedPorts).toEqual([4473]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("terminates a spawned server before releasing a failed construction reservation", async () => {
    const { manager, runtime } = createTestManager([4474], { autoAnnounce: false });
    let reservationReleaseSignal: NodeJS.Signals | null | undefined;
    manager.configureRuntimeCapacityController(
      new FailingTrackRuntimeCapacityController(() => {
        reservationReleaseSignal = runtime.processForPort(4474).signalCode;
      }),
    );

    await expect(manager.acquireCurrent()).rejects.toThrow("capacity tracking failed");

    expect(runtime.terminatedPorts).toEqual([4474]);
    expect(reservationReleaseSignal).toBe("SIGTERM");
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("rejects a new acquisition after shutdown starts", async () => {
    const { manager } = createTestManager([4475]);
    const acquisition = await manager.acquireCurrent();

    const shutdown = manager.shutdown();

    await expect(manager.acquireCurrent()).rejects.toThrow("manager is shutting down");
    expect(manager.acquireExisting(acquisition.server.url)).toBe(null);
    await shutdown;
  });

  test("dedicated server startup is protected from retired cleanup", async () => {
    const { manager, runtime } = createTestManager([4473, 4474], { autoAnnounce: false });

    const currentStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4473).announceListening();
    const currentAcquisition = await currentStart;

    const dedicatedStart = manager.acquireDedicated({ TEST_ENV: "custom" });
    await runtime.settle();

    await currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473]);

    runtime.processForPort(4474).announceListening();
    const dedicatedAcquisition = await dedicatedStart;

    expect(dedicatedAcquisition.server.url).toBe("http://127.0.0.1:4474");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473, 4474]);
  });

  test("acquireExisting keeps a retired dedicated server alive until every reference releases", async () => {
    const { manager, runtime } = createTestManager([4475]);

    const dedicatedAcquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const existingAcquisition = manager.acquireExisting(dedicatedAcquisition.server.url);

    expect(existingAcquisition?.server.url).toBe("http://127.0.0.1:4475");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);

    await existingAcquisition?.release();
    expect(runtime.terminatedPorts).toEqual([4475]);
  });

  test("acquireExisting returns null for unknown or dead server urls", async () => {
    const { manager, runtime } = createTestManager([4476]);

    const acquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const url = acquisition.server.url;

    expect(manager.acquireExisting("http://127.0.0.1:9999")).toBe(null);

    await acquisition.release();
    expect(runtime.terminatedPorts).toEqual([4476]);
    expect(manager.acquireExisting(url)).toBe(null);
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const { manager, runtime } = createTestManager([4501, 4502, 4503]);

    const firstAcquisition = await manager.acquireCurrent();
    const secondAcquisition = await manager.acquireNew();
    await secondAcquisition.release();
    const thirdAcquisition = await manager.acquireNew();
    await thirdAcquisition.release();
    await firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4502, 4503, 4501]);
  });

  test("final release detaches the terminating generation before a concurrent acquire", async () => {
    const { manager, runtime } = createTestManager([4551, 4552]);

    const first = await manager.acquireCurrent();
    const release = first.release();
    const next = await manager.acquireCurrent();

    await release;
    expect(next.server.url).toBe("http://127.0.0.1:4552");
    expect(runtime.terminatedPorts).toEqual([4551]);

    await next.release();
  });
});

describe("OpenCodeServerManager managed process ledger", () => {
  test("does not expose a helper until its managed-process record is durable", async () => {
    const { manager, runtime } = createTestManager([4600], {
      managedProcessRecordPending: true,
    });
    let acquired = false;
    const pendingAcquisition = manager.acquireCurrent().then((acquisition) => {
      acquired = true;
      return acquisition;
    });

    await runtime.settle();

    expect(acquired).toBe(false);
    runtime.releaseManagedProcessRecord();
    const acquisition = await pendingAcquisition;

    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    await acquisition.release();
  });

  test("does not acquire an existing helper while its managed-process record is pending", async () => {
    const { manager, runtime } = createTestManager([4606], {
      managedProcessRecordPending: true,
    });
    const pendingAcquisition = manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    await runtime.settle();

    expect(manager.acquireExisting("http://127.0.0.1:4606")).toBe(null);

    runtime.releaseManagedProcessRecord();
    const acquisition = await pendingAcquisition;
    const existingAcquisition = manager.acquireExisting(acquisition.server.url);
    expect(existingAcquisition?.server.url).toBe("http://127.0.0.1:4606");

    await existingAcquisition?.release();
    await acquisition.release();
  });

  test("fails startup when the helper exits while its managed-process record is pending", async () => {
    const { manager, runtime } = createTestManager([4607], {
      managedProcessRecordPending: true,
    });
    const pendingAcquisition = manager.acquireCurrent();
    await runtime.settle();

    runtime.processForPort(4607).exitNormally();
    runtime.releaseManagedProcessRecord();

    await expect(pendingAcquisition).rejects.toThrow("OpenCode server exited with code 0");
    await runtime.settle();
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("fails startup and terminates the exact helper when durable recording fails", async () => {
    const { manager, runtime } = createTestManager([4604], {
      managedProcessRecordError: new Error("managed process ledger failed"),
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("managed process ledger failed");

    expect(runtime.managedProcesses.verifiedRecordIds).toEqual(
      process.platform === "win32" ? ["managed-process-1"] : [],
    );
    expect(runtime.managedProcesses.verifiedProcessGroupIds).toEqual(
      process.platform === "win32" ? [] : [14604],
    );
    expect(runtime.terminatedPorts).toEqual([4604]);
    expect(runtime.processOnlySignalPorts).toEqual(process.platform === "win32" ? [4604] : []);
    expect(runtime.processGroupSignalPorts).toEqual(process.platform === "win32" ? [] : [4604]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("terminates an owned helper when startup fails before full identity capture", async () => {
    const { manager, runtime } = createTestManager([4608], {
      managedProcessRecordError: new Error("managed process identity inspection failed"),
      managedProcessIdentityCaptured: false,
    });

    await expect(manager.acquireCurrent()).rejects.toThrow(
      "managed process identity inspection failed",
    );

    expect(runtime.managedProcesses.verifiedRecordIds).toEqual(
      process.platform === "win32" ? ["managed-process-1"] : [],
    );
    expect(runtime.managedProcesses.verifiedProcessGroupIds).toEqual(
      process.platform === "win32" ? [] : [14608],
    );
    expect(runtime.terminatedPorts).toEqual([4608]);
    expect(runtime.processOnlySignalPorts).toEqual(process.platform === "win32" ? [4608] : []);
    expect(await runtime.managedProcesses.list()).toEqual([]);
    expect(runtime.launchedPorts).toEqual([4608]);
  });

  test("does not terminate a replacement process when durable recording fails", async () => {
    const { manager, runtime } = createTestManager([4605], {
      managedProcessRecordError: new Error("managed process ledger failed"),
      managedProcessIdentityMatches: false,
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("managed process ledger failed");

    expect(runtime.managedProcesses.verifiedRecordIds).toEqual(
      process.platform === "win32" ? ["managed-process-1"] : [],
    );
    expect(runtime.managedProcesses.verifiedProcessGroupIds).toEqual(
      process.platform === "win32" ? [] : [14605],
    );
    expect(runtime.terminatedPorts).toEqual([]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("starts another helper after cleanup finds a replacement process", async () => {
    const { manager, runtime } = createTestManager([4615, 4616]);
    const firstAcquisition = await manager.acquireCurrent();
    runtime.managedProcesses.setIdentityMatches(false);

    await firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([]);
    expect(await runtime.managedProcesses.list()).toEqual([]);

    runtime.managedProcesses.setIdentityMatches(true);
    const nextAcquisition = await manager.acquireCurrent();
    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4616");
    await nextAcquisition.release();
  });

  test("records helper server starts and removes the record on process exit", async () => {
    const { manager, runtime } = createTestManager([4601]);

    await manager.acquireCurrent();

    expect(await runtime.managedProcesses.list()).toEqual([
      {
        id: "managed-process-1",
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 14601,
        command: TEST_OPENCODE_COMMAND,
        args: ["serve", "--port", "4601"],
        metadata: {
          port: 4601,
          terminationScope: process.platform === "win32" ? "process" : "process-group",
          ...(process.platform === "win32" ? { directExecutable: true } : {}),
        },
        identity: {
          commandLine: `${TEST_OPENCODE_COMMAND} serve --port 4601`,
          startedAt: "test-process-start",
          ...(process.platform === "win32" ? {} : { ownershipToken: expect.any(String) as string }),
        },
        createdAt: "test-created-at",
      },
    ]);

    runtime.processForPort(4601).exitNormally();
    await runtime.settle();

    expect(await runtime.managedProcesses.list()).toEqual([]);
    expect(runtime.managedProcesses.cleanedOwnershipTokens).toHaveLength(
      process.platform === "win32" ? 0 : 1,
    );
  });

  test("retries record removal after a natural helper exit", async () => {
    const { manager, runtime } = createTestManager([4619, 4620]);
    await manager.acquireCurrent();
    runtime.managedProcesses.setRemoveError(new Error("temporary record removal failure"));

    runtime.processForPort(4619).exitNormally();
    await runtime.settle();

    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    runtime.managedProcesses.setRemoveError(undefined);
    const nextAcquisition = await manager.acquireCurrent();
    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4620");
    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    await nextAcquisition.release();
  });

  test.runIf(process.platform !== "win32")(
    "keeps ownership after descendant discovery fails on a natural helper exit",
    async () => {
      const { manager, runtime } = createTestManager([4621, 4622]);
      await manager.acquireCurrent();
      runtime.managedProcesses.setOwnedCleanupResults([{ complete: false, found: false }]);

      runtime.processForPort(4621).exitNormally();
      await runtime.settle();

      expect(await runtime.managedProcesses.list()).toHaveLength(1);
      runtime.managedProcesses.setOwnedCleanupResults([{ complete: true, found: true }]);
      const nextAcquisition = await manager.acquireCurrent();
      expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4622");
      await nextAcquisition.release();
    },
  );

  test("removes helper server records on shutdown", async () => {
    const { manager, runtime } = createTestManager([4602]);

    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4602]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("keeps the helper record when shutdown cannot confirm process exit", async () => {
    const { manager, runtime } = createTestManager([4609, 4610], {
      terminationResult: "kill-timeout",
    });
    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4609]);
    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    await expect(manager.acquireCurrent()).rejects.toThrow("manager is shutting down");
    expect(runtime.launchedPorts).toEqual([4609]);
  });

  test("retries incomplete cleanup before starting another helper", async () => {
    const { manager, runtime } = createTestManager([4613, 4614], {
      terminationResult: "kill-timeout",
    });
    const firstAcquisition = await manager.acquireCurrent();

    await firstAcquisition.release();
    runtime.setTerminationResult("terminated");
    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4614");
    expect(runtime.terminatedPorts).toEqual([4613, 4613]);
    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    await nextAcquisition.release();
  });

  test("retries durable record removal before starting another helper", async () => {
    const { manager, runtime } = createTestManager([4617, 4618]);
    const firstAcquisition = await manager.acquireCurrent();
    runtime.managedProcesses.setRemoveError(new Error("temporary record removal failure"));

    await firstAcquisition.release();
    expect(await runtime.managedProcesses.list()).toHaveLength(1);

    runtime.managedProcesses.setRemoveError(undefined);
    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4618");
    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    await nextAcquisition.release();
  });

  test("times out startup when durable recording remains pending", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4611], {
      managedProcessRecordPending: true,
      startupTimeoutMs: 0,
    });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server startup timeout");
    await runtime.settle();
    await vi.advanceTimersByTimeAsync(0);
    await failure;
    expect(runtime.terminatedPorts).toEqual([4611]);

    let shutdownComplete = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownComplete = true;
      return undefined;
    });
    await runtime.settle();
    expect(shutdownComplete).toBe(false);

    runtime.releaseManagedProcessRecord();
    await shutdown;
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("waits for record cleanup when identity capture completes after shutdown starts", async () => {
    const { manager, runtime } = createTestManager([4612], {
      managedProcessIdentityPending: true,
    });
    const pendingAcquisition = manager.acquireCurrent();
    const acquisitionFailure = pendingAcquisition.then(
      () => null,
      (error: unknown) => error,
    );
    await runtime.settle();

    let shutdownComplete = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownComplete = true;
      return undefined;
    });
    await runtime.settle();

    expect(shutdownComplete).toBe(false);
    expect(runtime.terminatedPorts).toEqual([4612]);

    runtime.releaseManagedProcessIdentity();
    await shutdown;
    expect(await acquisitionFailure).toBeInstanceOf(Error);
    expect(runtime.terminatedPorts).toEqual([4612]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("starts helper server from opencode-home", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-server-home-"));
    const opencodeHomeDir = path.join(tempDir, "opencode-home");
    try {
      const { manager, runtime } = createTestManager([4603], { opencodeHomeDir });

      const acquisition = await manager.acquireCurrent();

      expect(runtime.spawnCalls).toEqual([
        expect.objectContaining({
          command: TEST_OPENCODE_COMMAND,
          args: ["serve", "--port", "4603"],
          options: expect.objectContaining({ cwd: opencodeHomeDir }),
        }),
      ]);

      await acquisition.release();
      await manager.shutdown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OpenCode Windows helper ownership", () => {
  test("accepts only a direct opencode.exe command", () => {
    expect(isDirectOpenCodeWindowsExecutable("C:\\tools\\opencode.exe")).toBe(true);
    expect(isDirectOpenCodeWindowsExecutable("C:\\tools\\OPENCODE.EXE")).toBe(true);
    expect(isDirectOpenCodeWindowsExecutable("C:\\Windows\\System32\\cmd.exe")).toBe(false);
    expect(
      isDirectOpenCodeWindowsExecutable("C:\\Windows\\System32\\WindowsPowerShell\\powershell.exe"),
    ).toBe(false);
    expect(isDirectOpenCodeWindowsExecutable("C:\\Program Files\\nodejs\\node.exe")).toBe(false);
    expect(isDirectOpenCodeWindowsExecutable("C:\\tools\\opencode.cmd")).toBe(false);
  });
});

describe.runIf(process.platform === "win32")(
  "OpenCodeServerManager Windows OpenCode npm install",
  () => {
    test("starts the helper server from opencode.exe instead of the npm opencode.cmd shim", async () => {
      const detectedOpenCode = await findExecutable("opencode");
      expect(detectedOpenCode, "Windows CI must install opencode-ai before server tests").not.toBe(
        null,
      );
      expect(path.extname(detectedOpenCode!).toLowerCase()).toBe(".cmd");

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-real-windows-"));
      const opencodeHomeDir = path.join(tempDir, "opencode-home");
      const managedProcesses = new FakeManagedProcesses();
      const manager = new OpenCodeServerManager({
        logger: createTestLogger(),
        managedProcesses,
        resolveHomeDir: () => opencodeHomeDir,
      });
      let acquiredPort: number | null = null;

      try {
        const acquisition = await manager.acquireDedicated({
          OPENCODE_AUTH_CONTENT: "{}",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_PURE: "1",
          OPENCODE_TEST_HOME: path.join(tempDir, "test-home"),
        });
        acquiredPort = acquisition.server.port;

        const records = await managedProcesses.list();
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(path.extname(record.command).toLowerCase()).toBe(".exe");
        expect(path.normalize(record.command).toLowerCase()).toContain(
          path.normalize("node_modules/opencode-ai/bin/opencode.exe").toLowerCase(),
        );
        expect(record.command.toLowerCase()).not.toBe(detectedOpenCode!.toLowerCase());
        expect(record.args).toEqual(["serve", "--port", String(acquiredPort)]);
      } finally {
        await manager.shutdown().catch(() => undefined);
        if (acquiredPort !== null) {
          await waitForClosedPort(acquiredPort, 5_000);
        }
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 60_000);
  },
);

function createTestManager(
  ports: number[],
  options: {
    autoAnnounce?: boolean;
    baseEnv?: Record<string, string>;
    opencodeHomeDir?: string;
    managedProcessRecordError?: Error;
    managedProcessRecordPending?: boolean;
    managedProcessIdentityPending?: boolean;
    managedProcessIdentityCaptured?: boolean;
    managedProcessIdentityMatches?: boolean;
    terminationResult?: TerminateWithTreeKillResult;
    startupTimeoutMs?: number;
    portAllocationGate?: TestGate;
    terminationGate?: TestGate;
  } = {},
): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const { opencodeHomeDir } = options;
  const runtime = new FakeOpenCodeServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
    managedProcessRecordError: options.managedProcessRecordError,
    managedProcessRecordPending: options.managedProcessRecordPending ?? false,
    managedProcessIdentityPending: options.managedProcessIdentityPending ?? false,
    managedProcessIdentityCaptured: options.managedProcessIdentityCaptured ?? true,
    managedProcessIdentityMatches: options.managedProcessIdentityMatches ?? true,
    terminationResult: options.terminationResult ?? "terminated",
    portAllocationGate: options.portAllocationGate,
    terminationGate: options.terminationGate,
  });
  return {
    manager: new OpenCodeServerManager({
      logger: createTestLogger(),
      baseEnv: options.baseEnv,
      startupTimeoutMs: options.startupTimeoutMs,
      managedProcesses: runtime.managedProcesses,
      portAllocator: runtime.allocatePort,
      resolveCommandPrefix: runtime.resolveCommandPrefix,
      ...(opencodeHomeDir ? { resolveHomeDir: () => opencodeHomeDir } : {}),
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: runtime.terminateProcess,
    }),
    runtime,
  };
}

class FakeOpenCodeServerRuntime {
  readonly managedProcesses: FakeManagedProcesses;
  readonly processOnlySignalPorts: number[] = [];
  readonly processGroupSignalPorts: number[] = [];
  readonly terminatedPorts: number[] = [];
  readonly spawnCalls: Array<{
    command: string;
    args: string[];
    options: Parameters<OpenCodeServerProcessSpawner>[2];
  }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private terminationResult: TerminateWithTreeKillResult;
  private readonly portAllocationGate?: TestGate;
  private readonly terminationGate?: TestGate;
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  constructor(
    ports: number[],
    options: {
      autoAnnounce: boolean;
      managedProcessRecordError?: Error;
      managedProcessRecordPending: boolean;
      managedProcessIdentityPending: boolean;
      managedProcessIdentityCaptured: boolean;
      managedProcessIdentityMatches: boolean;
      terminationResult: TerminateWithTreeKillResult;
      portAllocationGate?: TestGate;
      terminationGate?: TestGate;
    },
  ) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
    this.terminationResult = options.terminationResult;
    this.managedProcesses = new FakeManagedProcesses({
      recordError: options.managedProcessRecordError,
      recordPending: options.managedProcessRecordPending,
      identityPending: options.managedProcessIdentityPending,
      identityCaptured: options.managedProcessIdentityCaptured,
      identityMatches: options.managedProcessIdentityMatches,
    });
    this.portAllocationGate = options.portAllocationGate;
    this.terminationGate = options.terminationGate;
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodePortAllocator = async () => {
    await this.portAllocationGate?.pause();
    const port = this.ports.shift();
    if (!port) {
      throw new Error("No fake OpenCode port available");
    }
    return port;
  };

  readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver = async () => ({
    command: TEST_OPENCODE_COMMAND,
    args: [],
  });

  readonly spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
    this.spawnCalls.push({ command, args, options });
    const port = Number(args.at(-1));
    const process = new FakeOpenCodeProcess({ port, pid: 10_000 + port });
    this.processesByChild.set(process.child, process);
    this.processesByPort.set(port, process);
    if (this.autoAnnounce) {
      queueMicrotask(() => process.announceListening());
    }
    return process.child;
  };

  readonly terminateProcess: ProcessTerminator = async (target: TreeKillTarget, options) => {
    if (options.beforeSignal && !(await options.beforeSignal("SIGTERM"))) {
      return "signal-skipped";
    }
    const process = this.processForTarget(target);
    this.terminatedPorts.push(process.port);
    await this.terminationGate?.pause();
    if (options.signalProcessOnly) {
      this.processOnlySignalPorts.push(process.port);
    }
    if (target.pid === -process.pid) {
      this.processGroupSignalPorts.push(process.port);
    }
    if (this.terminationResult === "terminated") {
      process.exitBySignal("SIGTERM");
    } else if (this.terminationResult === "killed") {
      process.exitBySignal("SIGKILL");
    }
    return this.terminationResult;
  };

  processForPort(port: number): FakeOpenCodeProcess {
    const process = this.processesByPort.get(port);
    if (!process) {
      throw new Error(`No fake OpenCode process for port ${port}`);
    }
    return process;
  }

  async settle(): Promise<void> {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  }

  releaseManagedProcessRecord(): void {
    this.managedProcesses.releaseRecord();
  }

  releaseManagedProcessIdentity(): void {
    this.managedProcesses.releaseIdentity();
  }

  setTerminationResult(result: TerminateWithTreeKillResult): void {
    this.terminationResult = result;
  }

  private processForTarget(target: TreeKillTarget): FakeOpenCodeProcess {
    const process =
      this.processesByChild.get(target as ChildProcess) ??
      Array.from(this.processesByPort.values()).find(
        (candidate) => Math.abs(target.pid ?? 0) === candidate.pid,
      );
    if (!process) {
      throw new Error("Unknown fake OpenCode process");
    }
    return process;
  }
}

class TestGate {
  private readonly reached: Promise<void>;
  private readonly released: Promise<void>;
  private markReached!: () => void;
  private markReleased!: () => void;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.markReached = resolve;
    });
    this.released = new Promise((resolve) => {
      this.markReleased = resolve;
    });
  }

  async pause(): Promise<void> {
    this.markReached();
    await this.released;
  }

  waitUntilReached(): Promise<void> {
    return this.reached;
  }

  release(): void {
    this.markReleased();
  }
}

class FailingTrackRuntimeCapacityController implements AgentRuntimeCapacityController {
  private reservations = 0;

  constructor(private readonly onReservationRelease: () => void) {}

  getAvailableRuntimeSlots(): number | null {
    return null;
  }

  reserve(): AgentRuntimeCapacityReservation {
    this.reservations += 1;
    if (this.reservations === 1) {
      return {
        track: () => {
          throw new Error("temporary reservation must not track a runtime");
        },
        release: () => undefined,
      };
    }
    return {
      track: () => {
        throw new Error("capacity tracking failed");
      },
      release: this.onReservationRelease,
    };
  }

  release(): void {
    throw new Error("failed reservation must not become tracked");
  }
}

class RecordingRuntimeCapacityController implements AgentRuntimeCapacityController {
  readonly events: string[] = [];
  private readonly controller: HostAgentRuntimeCapacityController;

  constructor(limit: number) {
    this.controller = new HostAgentRuntimeCapacityController(limit);
  }

  getAvailableRuntimeSlots(): number | null {
    return this.controller.getAvailableRuntimeSlots();
  }

  reserve(): AgentRuntimeCapacityReservation {
    this.events.push("reserve");
    const reservation = this.controller.reserve();
    return {
      track: (runtime) => {
        this.events.push("track");
        reservation.track(runtime);
      },
      release: () => {
        this.events.push("release");
        reservation.release();
      },
    };
  }

  release(runtime: object): void {
    this.events.push("runtime-release");
    this.controller.release(runtime);
  }
}

class FakeOpenCodeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly child: ChildProcess;
  readonly port: number;
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(options: { port: number; pid: number }) {
    super();
    this.port = options.port;
    this.pid = options.pid;
    this.child = this as unknown as ChildProcess;
  }

  announceListening(): void {
    this.stdout.emit("data", Buffer.from("listening on"));
  }

  failStartup(error: Error): void {
    this.emit("error", error);
  }

  exitNormally(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }

  exitBySignal(signal: NodeJS.Signals): void {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }

  markKillSignalSent(): void {
    this.killed = true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exitBySignal(signal ?? "SIGTERM");
    return true;
  }
}

class FakeManagedProcesses implements ManagedProcessRegistry {
  readonly cleanedOwnershipTokens: string[] = [];
  readonly verifiedRecordIds: string[] = [];
  readonly verifiedProcessGroupIds: number[] = [];
  private records: ManagedProcessRecord[] = [];
  private readonly recordError?: Error;
  private readonly identityCaptured: boolean;
  private identityMatches: boolean;
  private ownedCleanupResults: Array<{ complete: boolean; found: boolean }> = [];
  private removeError?: Error;
  private readonly recordGate: Promise<void> | null;
  private readonly identityGate: Promise<void> | null;
  private releaseRecordGate: () => void = () => undefined;
  private releaseIdentityGate: () => void = () => undefined;

  constructor(
    options: {
      recordError?: Error;
      recordPending?: boolean;
      identityPending?: boolean;
      identityCaptured?: boolean;
      identityMatches?: boolean;
    } = {},
  ) {
    this.recordError = options.recordError;
    this.identityCaptured = options.identityCaptured ?? true;
    this.identityMatches = options.identityMatches ?? true;
    this.recordGate = options.recordPending
      ? new Promise<void>((resolve) => {
          this.releaseRecordGate = resolve;
        })
      : null;
    this.identityGate = options.identityPending
      ? new Promise<void>((resolve) => {
          this.releaseIdentityGate = resolve;
        })
      : null;
  }

  async record(
    input: ManagedProcessRecordInput,
    options?: ManagedProcessRecordOptions,
  ): Promise<ManagedProcessRecord> {
    const { ownershipToken, ...recordInput } = input;
    const record: ManagedProcessRecord = {
      id: `managed-process-${this.records.length + 1}`,
      ...recordInput,
      metadata: input.metadata ?? {},
      identity: {
        commandLine: null,
        startedAt: null,
        ...(ownershipToken ? { ownershipToken: null } : {}),
      },
      createdAt: "test-created-at",
    };
    await Promise.resolve();
    if (this.recordGate) {
      await this.recordGate;
    }
    this.records.push(record);
    options?.onRecordPersisted?.(record);
    if (this.identityGate) {
      await this.identityGate;
    }
    if (this.recordError && !this.identityCaptured) {
      throw this.recordError;
    }
    if (this.identityCaptured) {
      record.identity = {
        commandLine: [input.command, ...input.args].join(" "),
        startedAt: "test-process-start",
        ...(ownershipToken ? { ownershipToken } : {}),
      };
      options?.onIdentityCaptured?.(record);
    }
    if (this.recordError) {
      throw this.recordError;
    }
    return record;
  }

  async verify(record: ManagedProcessRecord): Promise<ManagedProcessVerification> {
    this.verifiedRecordIds.push(record.id);
    return this.identityMatches ? "match" : "mismatch";
  }

  async verifyProcessGroup(identity: {
    processGroupId: number;
    ownershipToken: string;
  }): Promise<ManagedProcessVerification> {
    this.verifiedProcessGroupIds.push(identity.processGroupId);
    return this.identityMatches ? "match" : "mismatch";
  }

  async cleanupOwnedProcesses(
    ownershipToken: string,
  ): Promise<{ complete: boolean; found: boolean }> {
    this.cleanedOwnershipTokens.push(ownershipToken);
    return this.ownedCleanupResults.shift() ?? { complete: true, found: false };
  }

  releaseRecord(): void {
    this.releaseRecordGate();
  }

  releaseIdentity(): void {
    this.releaseIdentityGate();
  }

  setIdentityMatches(matches: boolean): void {
    this.identityMatches = matches;
  }

  setOwnedCleanupResults(results: Array<{ complete: boolean; found: boolean }>): void {
    this.ownedCleanupResults = [...results];
  }

  setRemoveError(error: Error | undefined): void {
    this.removeError = error;
  }

  async remove(id: string): Promise<void> {
    if (this.removeError) {
      throw this.removeError;
    }
    this.records = this.records.filter((record) => record.id !== id);
  }

  async list(): Promise<ManagedProcessRecord[]> {
    return this.records;
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    return {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };
  }
}

async function waitForClosedPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canConnectToPort(port))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`OpenCode helper server still accepts connections on port ${port}`);
}

function canConnectToPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
