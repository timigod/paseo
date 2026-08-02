import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { isPlatform } from "../src/test-utils/platform.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

interface SupervisorFixtureOptions {
  workerSource: string | ((tempDir: string) => string);
  restartOnCrash?: boolean;
  ownershipCommitFailure?: boolean;
  ownershipMode?: "delayed-first-commit" | "verify-escalation";
  workerStopTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

function createWorkerOwnershipSource(options: SupervisorFixtureOptions): string {
  if (options.ownershipCommitFailure) {
    return `{
      createClaim(env) {
        let workerPid = null;
        return {
          env,
          get workerPid() { return workerPid; },
          async commit(pid) {
            workerPid = pid;
            throw new Error("fixture ownership commit failed");
          },
          async verify() {
            recordOwnershipEvent("verify-commit-failure");
            return true;
          },
          async clear() {},
        };
      },
    }`;
  }
  if (options.ownershipMode === "delayed-first-commit") {
    return `{
      createClaim(env) {
        ownershipGeneration += 1;
        const generation = ownershipGeneration;
        let workerPid = null;
        let cleared = false;
        return {
          env,
          get workerPid() { return workerPid; },
          async commit(pid) {
            workerPid = pid;
            if (generation === 1) {
              const deadline = Date.now() + 100;
              while (Date.now() < deadline) {
                try {
                  if (readFileSync(ownershipEventsPath, "utf8").includes("clear-1")) {
                    break;
                  }
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            }
            recordOwnershipEvent("commit-" + generation);
          },
          async verify() { return true; },
          async clear() {
            if (!cleared) {
              cleared = true;
              recordOwnershipEvent("clear-" + generation);
            }
          },
        };
      },
    }`;
  }
  if (options.ownershipMode === "verify-escalation") {
    return `{
      createClaim(env) {
        let workerPid = null;
        return {
          env,
          get workerPid() { return workerPid; },
          async commit(pid) { workerPid = pid; },
          async verify() {
            ownershipVerifyCount += 1;
            recordOwnershipEvent("verify-" + ownershipVerifyCount);
            return ownershipVerifyCount === 1;
          },
          async clear() {},
        };
      },
    }`;
  }
  return "undefined";
}

async function runSupervisorFixture(options: SupervisorFixtureOptions): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  log: string;
  stdout: string;
  stderr: string;
  ownershipEvents: string[];
}> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-log-"));
  const logPath = path.join(tempDir, "daemon.log");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");
  const ownershipEventsPath = path.join(tempDir, "ownership-events.log");
  const workerSource =
    typeof options.workerSource === "function"
      ? options.workerSource(tempDir)
      : options.workerSource;
  const workerOwnershipSource = createWorkerOwnershipSource(options);

  await writeFile(workerPath, workerSource);
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};
      import { appendFileSync, readFileSync } from "node:fs";

      let ownershipGeneration = 0;
      let ownershipVerifyCount = 0;
      const ownershipEventsPath = ${JSON.stringify(ownershipEventsPath)};
      const recordOwnershipEvent = (event) => appendFileSync(ownershipEventsPath, event + "\\n");

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: process.env,
        workerExecArgv: [],
        restartOnCrash: ${JSON.stringify(options.restartOnCrash ?? false)},
        workerOwnership: ${workerOwnershipSource},
        workerStopTimeoutMs: ${JSON.stringify(options.workerStopTimeoutMs)},
        platform: ${JSON.stringify(options.platform)},
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("supervisor fixture timed out"));
    }, 10000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  const log = await readFile(logPath, "utf8");
  const ownershipEvents = await readFile(ownershipEventsPath, "utf8")
    .then((content) => content.trim().split("\n").filter(Boolean))
    .catch(() => []);
  return { code, signal, log, stdout, stderr, ownershipEvents };
}

describe("supervisor durable logging", () => {
  test("resolves rotation defaults", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(paseoHome, {}, {});

    expect(logFile).toEqual({
      path: path.join(paseoHome, "daemon.log"),
      rotate: { maxSize: "10m", maxFiles: 3 },
    });
  });

  test("lets persisted rotation override env rotation defaults", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(
      paseoHome,
      {
        log: {
          file: {
            path: "logs/daemon.log",
            rotate: { maxSize: "25m", maxFiles: 4 },
          },
        },
      },
      {
        PASEO_LOG_ROTATE_SIZE: "200m",
        PASEO_LOG_ROTATE_COUNT: "12",
      },
    );

    expect(logFile).toEqual({
      path: path.resolve(paseoHome, "logs", "daemon.log"),
      rotate: { maxSize: "25m", maxFiles: 4 },
    });
  });

  test("uses env rotation when persisted rotation is absent", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(
      paseoHome,
      {},
      {
        PASEO_LOG_ROTATE_SIZE: "50m",
        PASEO_LOG_ROTATE_COUNT: "8",
      },
    );

    expect(logFile).toEqual({
      path: path.join(paseoHome, "daemon.log"),
      rotate: { maxSize: "50m", maxFiles: 8 },
    });
  });

  test("writes supervised worker stdout and stderr to daemon.log", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('{"level":30,"msg":"worker-json-stdout"}\\n');
        process.stderr.write('{"level":50,"msg":"worker-json-stderr"}\\n');
        process.exit(0);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"worker-json-stdout"');
    expect(result.log).toContain('"worker-json-stderr"');
    expect(result.stdout).toContain('"worker-json-stdout"');
    expect(result.stderr).toContain('"worker-json-stderr"');
  });

  test("preserves raw non-JSON stdout and stderr lines", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('raw stdout line\\n');
        process.stderr.write('raw stderr line\\n');
        process.exit(0);
      `,
    });

    expect(result.log).toContain("raw stdout line\n");
    expect(result.log).toContain("raw stderr line\n");
  });

  test("does not restart after worker ownership commit fails", async () => {
    const result = await runSupervisorFixture({
      workerSource: `setInterval(() => {}, 1000);`,
      restartOnCrash: true,
      ownershipCommitFailure: true,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Worker ownership commit failed: fixture ownership commit failed",
    );
    expect(result.stderr).not.toContain("Restarting worker");
    expect(result.ownershipEvents).toEqual(["verify-commit-failure"]);
  });

  test("finishes one generation's ownership lifecycle before restarting", async () => {
    const result = await runSupervisorFixture({
      workerSource: (tempDir) => {
        const firstRunMarker = path.join(tempDir, "first-run-complete");
        return `
          import { existsSync, writeFileSync } from "node:fs";
          const marker = ${JSON.stringify(firstRunMarker)};
          if (!existsSync(marker)) {
            writeFileSync(marker, "done");
            process.exit(1);
          }
          process.exit(0);
        `;
      },
      restartOnCrash: true,
      ownershipMode: "delayed-first-commit",
    });

    expect(result.code).toBe(0);
    expect(result.ownershipEvents).toEqual(["commit-1", "clear-1", "commit-2", "clear-2"]);
  });

  test("re-verifies ownership before initial and escalation signals", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.on("SIGTERM", () => {});
        process.send?.({ type: "paseo:shutdown", reason: "verify_each_signal" });
        setTimeout(() => process.exit(0), 200);
      `,
      ownershipMode: "verify-escalation",
      workerStopTimeoutMs: 20,
    });

    expect(result.code).toBe(1);
    expect(result.ownershipEvents).toEqual(["verify-1", "verify-2"]);
    expect(result.stderr).toContain("Refusing SIGKILL");
  });

  test("uses and reports forced worker termination on Windows", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.send?.({ type: "paseo:shutdown", reason: "windows_shutdown" });
        setInterval(() => {}, 1000);
      `,
      platform: "win32",
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain('"signal":"SIGKILL"');
    expect(result.log).toContain('"termination":"forceful"');
    expect(result.stderr).toContain("Forcing worker termination on Windows");
  });

  test("logs the worker shutdown reason before signaling the worker", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.send?.({ type: "paseo:shutdown", reason: "client_shutdown_rpc" });
        setInterval(() => {}, 1000);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"msg":"Worker requested shutdown"');
    expect(result.log).toContain('"reason":"client_shutdown_rpc"');
    expect(result.log).toContain('"msg":"Supervisor sending signal to worker"');
    expect(result.log).toContain('"signal":"SIGTERM"');
    expect(result.log).toContain('"workerPid":');
  });

  // POSIX-only: Windows reports the worker self-kill as an exit code, not SIGKILL.
  test.skipIf(isPlatform("win32"))(
    "logs worker signal exits even when the worker cannot log",
    async () => {
      const result = await runSupervisorFixture({
        workerSource: `
        process.kill(process.pid, "SIGKILL");
      `,
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.log).toContain('"msg":"Worker exited"');
      expect(result.log).toContain('"signal":"SIGKILL"');
      expect(result.log).toContain("Supervisor exiting");
    },
  );
});
