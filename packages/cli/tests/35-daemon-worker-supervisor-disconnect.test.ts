#!/usr/bin/env npx tsx

/**
 * Regression: a replacement supervisor must recover an identity-proved worker
 * even when that worker is too wedged to process IPC disconnect or SIGTERM.
 */

import assert from "node:assert";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

const pollIntervalMs = 100;
const testEnv = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? "0",
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? "0",
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? "0",
  PASEO_NODE_INSPECT: "0",
};
const cliRoot = join(import.meta.dirname, "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
  }
}

interface DaemonStatus {
  localDaemon: string | null;
  pid: number | null;
}

async function readDaemonStatus(paseoHome: string): Promise<DaemonStatus> {
  const result =
    await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon status --home ${paseoHome} --json`.nothrow();
  if (result.exitCode !== 0) return { localDaemon: null, pid: null };
  try {
    const parsed = JSON.parse(result.stdout) as { localDaemon?: unknown; pid?: unknown };
    return {
      localDaemon: typeof parsed.localDaemon === "string" ? parsed.localDaemon : null,
      pid:
        typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { localDaemon: null, pid: null };
  }
}

interface WorkerIdentity {
  pid: number;
  token: string;
}

async function readWorkerIdentity(paseoHome: string): Promise<WorkerIdentity | null> {
  try {
    const raw = await readFile(join(paseoHome, "supervisor-worker.json"), "utf8");
    const parsed = JSON.parse(raw) as { worker?: { pid?: unknown; token?: unknown } };
    const pid = parsed.worker?.pid;
    const token = parsed.worker?.token;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof token === "string"
      ? { pid, token }
      : null;
  } catch {
    return null;
  }
}

function processHasToken(pid: number, token: string): boolean {
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.includes(`PASEO_SUPERVISOR_WORKER_TOKEN=${token}`);
}

function startSupervisor(paseoHome: string, port: number, capture: (text: string) => void) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "../server/scripts/supervisor-entrypoint.ts", "--dev"],
    {
      cwd: cliRoot,
      env: {
        ...process.env,
        ...testEnv,
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_RELAY_ENABLED: "false",
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => capture(chunk.toString()));
  child.stderr?.on("data", (chunk) => capture(chunk.toString()));
  return child;
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("supervisor did not exit in time")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

console.log("=== Daemon Orphan Worker Ownership Regression ===\n");

const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-orphan-worker-"));
let supervisorProcess: ChildProcess | null = null;
let orphanWorker: WorkerIdentity | null = null;
let recentSupervisorLogs = "";
const captureLogs = (text: string) => {
  recentSupervisorLogs = (recentSupervisorLogs + text).slice(-16000);
};

try {
  console.log("Test 1: replacement recovers a wedged worker after supervisor SIGKILL");
  supervisorProcess = startSupervisor(paseoHome, port, captureLogs);
  await waitFor(
    async () => {
      if (supervisorProcess?.exitCode !== null || supervisorProcess?.signalCode !== null) {
        throw new Error("supervisor exited before daemon became running");
      }
      return (await readDaemonStatus(paseoHome)).localDaemon === "running";
    },
    120000,
    "daemon did not become running",
  ).catch((error) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${recentSupervisorLogs}`,
    );
  });
  orphanWorker = await readWorkerIdentity(paseoHome);
  assert(orphanWorker !== null, "worker ownership state should record the worker identity");
  assert(isProcessRunning(orphanWorker.pid), "worker should be running before the wedge");

  process.kill(orphanWorker.pid, "SIGSTOP");
  supervisorProcess.kill("SIGKILL");
  await waitForExit(supervisorProcess, 15000);
  assert(isProcessRunning(orphanWorker.pid), "wedged worker should survive supervisor SIGKILL");

  supervisorProcess = startSupervisor(paseoHome, port, captureLogs);
  await waitFor(
    async () => {
      if (supervisorProcess?.exitCode !== null || supervisorProcess?.signalCode !== null) {
        throw new Error(`replacement supervisor exited during recovery\n${recentSupervisorLogs}`);
      }
      const worker = await readWorkerIdentity(paseoHome);
      return worker !== null && worker.pid !== orphanWorker?.pid && isProcessRunning(worker.pid);
    },
    120000,
    `replacement did not recover wedged worker; logs:\n${recentSupervisorLogs}`,
  );
  await waitFor(
    async () => (await readDaemonStatus(paseoHome)).localDaemon === "running",
    120000,
    "replacement worker did not become reachable",
  );
  assert.match(recentSupervisorLogs, /Recovered owned stale worker PID .*terminated-forcefully/);
  console.log("✓ replacement force-recovered only its recorded orphan worker\n");

  console.log("Test 2: unrelated port owner is diagnosed and never killed");
  const unrelatedPort = await getAvailablePort();
  const unrelatedHome = await mkdtemp(join(tmpdir(), "paseo-unrelated-port-owner-"));
  const unrelatedServer = createServer();
  await new Promise<void>((resolve, reject) => {
    unrelatedServer.once("error", reject);
    unrelatedServer.listen(unrelatedPort, "127.0.0.1", resolve);
  });
  let unrelatedLogs = "";
  const unrelatedSupervisor = startSupervisor(unrelatedHome, unrelatedPort, (text) => {
    unrelatedLogs = (unrelatedLogs + text).slice(-16000);
  });
  try {
    const exit = await waitForExit(unrelatedSupervisor, 120000);
    assert.strictEqual(exit.code, 1, `unknown port owner startup should fail: ${unrelatedLogs}`);
    assert.strictEqual(unrelatedServer.listening, true, "unrelated server should remain listening");
    assert.strictEqual(
      await canConnect(unrelatedPort),
      true,
      "unrelated port should remain reachable",
    );
    assert.match(unrelatedLogs, /refusing to terminate the unknown port owner/);
  } finally {
    if (isProcessRunning(unrelatedSupervisor.pid ?? -1)) unrelatedSupervisor.kill("SIGKILL");
    await new Promise<void>((resolve) => unrelatedServer.close(() => resolve()));
    await rm(unrelatedHome, { recursive: true, force: true });
  }
  console.log("✓ unrelated process remained alive and received actionable diagnosis\n");
} finally {
  if (supervisorProcess?.pid && isProcessRunning(supervisorProcess.pid)) {
    supervisorProcess.kill("SIGTERM");
    await waitForExit(supervisorProcess, 20000).catch(() => supervisorProcess?.kill("SIGKILL"));
  }
  if (orphanWorker && processHasToken(orphanWorker.pid, orphanWorker.token)) {
    process.kill(orphanWorker.pid, "SIGCONT");
    await waitFor(
      () => !processHasToken(orphanWorker!.pid, orphanWorker!.token),
      5000,
      "owned orphan did not exit after cleanup resume",
    ).catch(() => {
      if (processHasToken(orphanWorker!.pid, orphanWorker!.token)) {
        process.kill(orphanWorker!.pid, "SIGKILL");
      }
    });
  }
  await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon stop --home ${paseoHome} --force`.nothrow();
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Daemon orphan worker ownership regression passed ===");
