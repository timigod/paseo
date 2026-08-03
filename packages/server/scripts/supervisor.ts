import { fork, spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createStream as createRotatingFileStream } from "rotating-file-stream";
import {
  SUPERVISOR_OWNERSHIP_COMMITTED_MESSAGE,
  type SupervisorWorkerClaim,
  type SupervisorWorkerOwnership,
} from "../src/server/supervisor-worker-ownership.js";

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    }
  | {
      type: "paseo:start-failed";
      code: string;
      message: string;
      listen: string;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
}

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string }) => Promise<void> | void;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
  workerOwnership?: SupervisorWorkerOwnership;
  startupReceipt?: {
    message: string;
    fields: Record<string, unknown>;
  };
  platform?: NodeJS.Platform;
  workerStopTimeoutMs?: number;
  /**
   * An external service manager owns this daemon. The pid lock names the
   * supervisor, so any client that falls back to signalling the lock owner —
   * including a released CLI that predates the shutdown fence — aims at this
   * process. Signals carry no sender identity, so the supervisor cannot refuse
   * one without also refusing its own service manager. It instead refuses to
   * turn an unauthorized stop into a silent clean exit.
   */
  serviceManaged?: boolean;
}

/** Exit code for a service-managed daemon stopped without going through the authorized route. */
export const UNAUTHORIZED_SERVICE_MANAGED_STOP_EXIT_CODE = 75;

/**
 * Reserved for an owning service manager's deliberate stop. Routine clients
 * and older Paseo releases use SIGTERM, so it cannot also prove ownership.
 */
export const SERVICE_MANAGER_STOP_SIGNAL = "SIGQUIT" as const;

export interface SupervisorController {
  requestShutdown(reason: string): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:ready") {
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen };
  }
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:start-failed") {
    const code = (msg as { code?: unknown }).code;
    const message = (msg as { message?: unknown }).message;
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof code !== "string" || typeof message !== "string" || typeof listen !== "string") {
      return null;
    }
    return { type: "paseo:start-failed", code, message, listen };
  }
  return null;
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

function createSupervisorLogStream(options: SupervisorLogFileOptions | undefined) {
  if (!options) {
    return null;
  }

  mkdirSync(path.dirname(options.path), { recursive: true });
  return createRotatingFileStream(path.basename(options.path), {
    path: path.dirname(options.path),
    size: toRotatingFileStreamSize(options.rotate.maxSize),
    maxFiles: options.rotate.maxFiles,
  });
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;
  const platform = options.platform ?? process.platform;
  const shutdownTermination = platform === "win32" ? "forceful" : "graceful";
  const workerStopTimeoutMs = options.workerStopTimeoutMs ?? 12_000;

  const serviceManaged = options.serviceManaged ?? false;

  let child: ChildProcess | null = null;
  let childOwnership: SupervisorWorkerClaim | null = null;
  let childOwnershipSettled = Promise.resolve(true);
  let workerStopTimer: NodeJS.Timeout | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  let workerStartupFailure: Extract<WorkerLifecycleMessage, { type: "paseo:start-failed" }> | null =
    null;
  // Only a worker-relayed `paseo:shutdown` proves the stop cleared the session
  // fence, which means the daemon is unmanaged or an operator passed
  // serviceMaintenance. A signal proves nothing about who sent it.
  let stopAuthorized = false;
  const logStream = createSupervisorLogStream(options.logFile);

  const writeDurableChunk = (chunk: string | Buffer): void => {
    logStream?.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string, fields: Record<string, unknown> = {}): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message, fields);
  };

  const closeLogStream = (): Promise<void> =>
    new Promise((resolve) => {
      if (!logStream) {
        resolve();
        return;
      }
      logStream.end(resolve);
    });

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const clearWorkerStopTimer = (): void => {
    if (workerStopTimer) {
      clearTimeout(workerStopTimer);
      workerStopTimer = null;
    }
  };

  const signalVerifiedWorker = async (
    currentChild: ChildProcess,
    ownership: SupervisorWorkerClaim | null,
    signal: NodeJS.Signals,
    reason: string,
  ): Promise<"sent" | "gone" | "refused"> => {
    if (child !== currentChild || currentChild.exitCode !== null || currentChild.signalCode) {
      return "gone";
    }
    if (ownership && !(await ownership.verify())) {
      log(
        `Worker PID ${
          currentChild.pid ?? "unknown"
        } ownership identity no longer matches. Refusing ${signal}; inspect the worker PID manually.`,
      );
      return "refused";
    }
    if (child !== currentChild || currentChild.exitCode !== null || currentChild.signalCode) {
      return "gone";
    }
    writeLifecycleLog("Supervisor sending signal to worker", {
      reason,
      signal,
      termination: platform !== "win32" && signal === "SIGTERM" ? "graceful" : "forceful",
      supervisorPid: process.pid,
      workerPid: currentChild.pid ?? null,
    });
    return currentChild.kill(signal) ? "sent" : "gone";
  };

  const scheduleWorkerEscalation = (
    currentChild: ChildProcess,
    ownership: SupervisorWorkerClaim | null,
    reason: string,
  ): void => {
    clearWorkerStopTimer();
    workerStopTimer = setTimeout(() => {
      void (async () => {
        writeLifecycleLog("Worker graceful stop timed out; escalating", {
          reason,
          signal: "SIGKILL",
          workerPid: currentChild.pid ?? null,
        });
        log(`${reason}. Worker did not stop gracefully; sending SIGKILL...`);
        const result = await signalVerifiedWorker(currentChild, ownership, "SIGKILL", reason);
        if (result === "refused") {
          exitSupervisor(1);
        }
      })().catch((error) => {
        log(`Worker escalation failed: ${error instanceof Error ? error.message : String(error)}`);
        exitSupervisor(1);
      });
    }, workerStopTimeoutMs);
    workerStopTimer.unref();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    const ownership = options.workerOwnership?.createClaim(spawnSpec?.env ?? workerEnv) ?? null;
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: ownership?.env ?? spawnSpec.env ?? workerEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: ownership?.env ?? workerEnv,
        execArgv: workerExecArgv,
      });
    }

    const currentChild = child;
    childOwnership = ownership;
    let ownershipSettled = Promise.resolve(true);
    childOwnershipSettled = ownershipSettled;
    workerStartupFailure = null;
    if (ownership) {
      const workerPid = currentChild.pid;
      if (!workerPid) {
        log("Spawned worker did not expose a PID; refusing unowned startup");
        currentChild.kill("SIGKILL");
        exitSupervisor(1);
        return;
      }
      ownershipSettled = ownership
        .commit(workerPid)
        .then(async () => {
          if (child !== currentChild || !currentChild.connected) {
            await ownership.clear();
            return true;
          }
          writeLifecycleLog("Worker ownership committed", { workerPid });
          currentChild.send({
            type: SUPERVISOR_OWNERSHIP_COMMITTED_MESSAGE,
            shutdownTermination,
          });
          return true;
        })
        .catch(async (error) => {
          log(
            `Worker ownership commit failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          try {
            await signalVerifiedWorker(
              currentChild,
              ownership,
              "SIGKILL",
              "worker_ownership_commit_failed",
            );
          } catch (verificationError) {
            log(
              `Worker ownership verification failed during commit cleanup: ${
                verificationError instanceof Error
                  ? verificationError.message
                  : String(verificationError)
              }`,
            );
          }
          exitSupervisor(1);
          return false;
        });
      childOwnershipSettled = ownershipSettled;
    }
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = {
        type: "paseo:supervisor-heartbeat",
      };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, 1000);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        Promise.resolve(options.onWorkerReady?.({ listen: lifecycleMessage.listen })).catch(
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
          },
        );
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", { reason });
        // The worker only relays this after the session shutdown fence passed.
        requestShutdown(reason, true);
        return;
      }

      if (lifecycleMessage.type === "paseo:start-failed") {
        workerStartupFailure = lifecycleMessage;
        log(
          `Daemon worker could not listen on ${lifecycleMessage.listen} (${lifecycleMessage.code}: ${lifecycleMessage.message}). No owned stale worker matched this startup; refusing to terminate the unknown port owner.`,
        );
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", { reason });
      requestRestart(reason);
    });

    child.on("close", (code, signal) => {
      void (async () => {
        clearInterval(heartbeat);
        clearWorkerStopTimer();
        const exitDescriptor = describeExit(code, signal);
        writeLifecycleLog("Worker exited", {
          code,
          signal,
          exit: exitDescriptor,
        });
        await ownershipSettled;
        if (ownership) {
          await ownership.clear();
        }
        if (child === currentChild) {
          childOwnership = null;
        }
        if (exiting) {
          return;
        }

        if (shuttingDown) {
          if (serviceManaged && !stopAuthorized) {
            log(
              `Worker exited (${exitDescriptor}). Supervisor stopping without an authorized service maintenance request.`,
            );
            writeLifecycleLog("Unauthorized stop of a service-managed daemon", {
              exit: exitDescriptor,
            });
            exitSupervisor(UNAUTHORIZED_SERVICE_MANAGED_STOP_EXIT_CODE);
            return;
          }
          log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
          exitSupervisor(0);
          return;
        }

        if (workerStartupFailure) {
          log(`Worker startup failed (${exitDescriptor}). Supervisor exiting.`);
          exitSupervisor(1);
          return;
        }

        // Reaching this branch means no supervisor shutdown was requested. For a
        // service-managed daemon, only `restarting` proves that the supervisor
        // authorized this worker exit. Exit metadata cannot prove intent: the
        // production worker handles SIGTERM and turns it into `code: 0, signal:
        // null`, which otherwise looks like a voluntary clean stop.
        if (serviceManaged && !restarting) {
          log(
            `Worker exited (${exitDescriptor}) without a supervisor lifecycle request. Restarting worker...`,
          );
          writeLifecycleLog(
            "Restarting worker after an exit without a supervisor lifecycle request",
            { code, signal, exit: exitDescriptor },
          );
          spawnWorker();
          return;
        }

        const crashed =
          restartOnCrash &&
          ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

        if (restarting || crashed) {
          restarting = false;
          log(
            crashed
              ? `Worker crashed (${exitDescriptor}). Restarting worker...`
              : `Worker exited (${exitDescriptor}). Restarting worker...`,
          );
          spawnWorker();
          return;
        }

        log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
        exitSupervisor(typeof code === "number" ? code : 1);
      })().catch((error) => {
        log(
          `Worker exit cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        exitSupervisor(1);
      });
    });
  };

  const signalWorker = (signal: NodeJS.Signals, reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    const ownership = childOwnership;
    const ownershipSettled = childOwnershipSettled;
    void ownershipSettled
      .then(async (committed) => {
        if (!committed) {
          return undefined;
        }
        const result = await signalVerifiedWorker(currentChild, ownership, signal, reason);
        if (result === "refused") {
          exitSupervisor(1);
          return undefined;
        }
        if (result === "sent" && signal !== "SIGKILL") {
          scheduleWorkerEscalation(currentChild, ownership, reason);
        }
        return undefined;
      })
      .catch((error) => {
        log(`Worker signal failed: ${error instanceof Error ? error.message : String(error)}`);
        exitSupervisor(1);
      });
  };

  const requestRestart = (reason: string) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    if (platform === "win32") {
      log(`${reason}. Forcing worker termination for restart on Windows...`);
      signalWorker("SIGKILL", reason);
    } else {
      log(`${reason}. Stopping worker for restart...`);
      signalWorker("SIGTERM", reason);
    }
  };

  const requestShutdown = (reason: string, authorized = false) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    stopAuthorized = authorized;
    writeLifecycleLog("Supervisor shutdown requested", { reason, authorized });
    log(
      shutdownTermination === "forceful"
        ? `${reason}. Forcing worker termination on Windows...`
        : `${reason}. Stopping worker...`,
    );
    if (!child) {
      exitSupervisor(
        serviceManaged && !authorized ? UNAUTHORIZED_SERVICE_MANAGED_STOP_EXIT_CODE : 0,
      );
      return;
    }
    signalWorker(shutdownTermination === "forceful" ? "SIGKILL" : "SIGTERM", reason);
  };

  // Stop gracefully either way — fighting the service manager would only earn a
  // SIGKILL and lose the agents. The exit code is what carries the refusal, so a
  // restart policy brings the host back instead of leaving it down.
  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  // SIGQUIT is an ownership signal only for explicitly service-managed
  // supervisors. Unmanaged and Desktop supervisors retain Node's native
  // SIGQUIT termination behavior.
  if (serviceManaged && process.platform !== "win32") {
    process.on(SERVICE_MANAGER_STOP_SIGNAL, () => {
      requestShutdown(`supervisor_received_${SERVICE_MANAGER_STOP_SIGNAL}`, true);
    });
  }

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  if (options.startupReceipt) {
    log(options.startupReceipt.message, options.startupReceipt.fields);
  }
  spawnWorker();

  return { requestShutdown };
}
