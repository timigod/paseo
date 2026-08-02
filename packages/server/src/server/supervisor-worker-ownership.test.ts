import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ManagedProcessInspection,
  ManagedProcessTable,
} from "./managed-processes/managed-processes.js";
import {
  SUPERVISOR_WORKER_TOKEN_ENV,
  SupervisorWorkerOwnership,
  SupervisorWorkerOwnershipError,
} from "./supervisor-worker-ownership.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeProcessTable implements ManagedProcessTable {
  readonly processes = new Map<number, ManagedProcessInspection>();

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    return this.processes.get(pid) ?? { status: "not-found" };
  }

  async inspectProcessGroup(): Promise<{ status: "not-found" }> {
    return { status: "not-found" };
  }
}

async function createFixture(options?: {
  onSignal?: (processTable: FakeProcessTable, pid: number, signal: NodeJS.Signals) => void;
}) {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-worker-"));
  tempDirs.push(paseoHome);
  const workerEntry = path.join(paseoHome, "daemon-worker.js");
  await writeFile(workerEntry, "// fixture\n");
  const processTable = new FakeProcessTable();
  const signals: NodeJS.Signals[] = [];
  const workerPid = 4101;
  const createOwnership = () =>
    new SupervisorWorkerOwnership({
      paseoHome,
      workerEntry,
      desktopManaged: false,
      processTable,
      platform: "darwin",
      gracefulTimeoutMs: 5,
      forceTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      signalProcess: (pid, signal) => {
        expect(pid).toBe(workerPid);
        signals.push(signal);
        if (options?.onSignal) {
          options.onSignal(processTable, pid, signal);
        } else if (signal === "SIGKILL") {
          processTable.processes.delete(pid);
        }
      },
    });

  const owner = createOwnership();
  const claim = owner.createClaim({});
  const token = claim.env[SUPERVISOR_WORKER_TOKEN_ENV];
  expect(token).toEqual(expect.any(String));
  processTable.processes.set(workerPid, {
    status: "alive",
    snapshot: {
      pid: workerPid,
      commandLine: "node daemon-worker.js",
      startedAt: "Sun Aug  2 10:00:00 2026",
      token,
    },
  });
  await claim.commit(workerPid);

  return { paseoHome, workerPid, processTable, signals, createOwnership };
}

describe("supervisor worker ownership", () => {
  test("gracefully tries then force-terminates the exact stale worker and is idempotent", async () => {
    const fixture = await createFixture();
    const replacement = fixture.createOwnership();

    await expect(replacement.recoverStaleWorker()).resolves.toEqual({
      status: "terminated-forcefully",
      workerPid: fixture.workerPid,
    });
    expect(fixture.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(replacement.recoverStaleWorker()).resolves.toEqual({ status: "none" });
  });

  test("fails closed when the recorded PID has been reused", async () => {
    const fixture = await createFixture();
    fixture.processTable.processes.set(fixture.workerPid, {
      status: "alive",
      snapshot: {
        pid: fixture.workerPid,
        commandLine: "node daemon-worker.js",
        startedAt: "Sun Aug  2 11:00:00 2026",
        token: "unrelated-token",
      },
    });

    await expect(fixture.createOwnership().recoverStaleWorker()).rejects.toThrow(
      /Refusing to signal stale worker PID 4101.*possible PID reuse.*State remains/s,
    );
    expect(fixture.signals).toEqual([]);
    await expect(
      readFile(path.join(fixture.paseoHome, "supervisor-worker.json"), "utf8"),
    ).resolves.toContain('"pid": 4101');
  });

  test("does not signal a replacement that reuses the worker PID after termination", async () => {
    const fixture = await createFixture({
      onSignal: (processTable, pid, signal) => {
        if (signal === "SIGTERM") {
          processTable.processes.set(pid, {
            status: "alive",
            snapshot: {
              pid,
              commandLine: "unrelated process",
              startedAt: "Sun Aug  2 10:00:01 2026",
              token: null,
            },
          });
        }
      },
    });

    await expect(fixture.createOwnership().recoverStaleWorker()).resolves.toEqual({
      status: "terminated-gracefully",
      workerPid: fixture.workerPid,
    });
    expect(fixture.signals).toEqual(["SIGTERM"]);
  });

  test("preserves ownership state when identity inspection fails after signaling", async () => {
    const fixture = await createFixture({
      onSignal: (processTable, pid, signal) => {
        if (signal === "SIGTERM") {
          processTable.processes.set(pid, {
            status: "error",
            error: new Error("fixture inspection failure"),
          });
        }
      },
    });

    await expect(fixture.createOwnership().recoverStaleWorker()).rejects.toThrow(
      /ownership could not be proved because process identity inspection failed.*State remains/s,
    );
    expect(fixture.signals).toEqual(["SIGTERM"]);
    await expect(
      readFile(path.join(fixture.paseoHome, "supervisor-worker.json"), "utf8"),
    ).resolves.toContain('"pid": 4101');
  });

  test("fails closed when the same process becomes unverifiable after signaling", async () => {
    const fixture = await createFixture({
      onSignal: (processTable, pid, signal) => {
        if (signal === "SIGTERM") {
          processTable.processes.set(pid, {
            status: "alive",
            snapshot: {
              pid,
              commandLine: "node daemon-worker.js",
              startedAt: "Sun Aug  2 10:00:00 2026",
              token: null,
            },
          });
        }
      },
    });

    await expect(fixture.createOwnership().recoverStaleWorker()).rejects.toThrow(
      /ownership could not be proved because worker identity token is unavailable.*State remains/s,
    );
    expect(fixture.signals).toEqual(["SIGTERM"]);
  });

  test("fails closed with actionable output for invalid stale state", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.paseoHome, "supervisor-worker.json"), '{"version":1}');

    await expect(fixture.createOwnership().recoverStaleWorker()).rejects.toEqual(
      expect.objectContaining<Partial<SupervisorWorkerOwnershipError>>({
        name: "SupervisorWorkerOwnershipError",
        message: expect.stringMatching(/Invalid stale worker ownership state.*Refusing to signal/s),
      }),
    );
    expect(fixture.signals).toEqual([]);
  });
});
