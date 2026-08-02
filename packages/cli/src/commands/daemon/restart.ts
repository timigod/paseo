import type { Command } from "commander";
import {
  startLocalDaemonDetached,
  stopLocalDaemon,
  DEFAULT_STOP_TIMEOUT_MS,
  type DaemonStartOptions,
} from "./local-daemon.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface RestartResult {
  action: "restarted";
  home: string;
  pid: string;
  forced: boolean;
  usedLifecycleRpc: boolean;
  reason: Awaited<ReturnType<typeof stopLocalDaemon>>["reason"];
  message: string;
}

export interface RestartCommandRuntime {
  stopLocalDaemon(
    options: Parameters<typeof stopLocalDaemon>[0],
  ): ReturnType<typeof stopLocalDaemon>;
  startLocalDaemonDetached(
    options: DaemonStartOptions,
  ): ReturnType<typeof startLocalDaemonDetached>;
}

const defaultRestartCommandRuntime: RestartCommandRuntime = {
  stopLocalDaemon,
  startLocalDaemonDetached,
};

const restartResultSchema: OutputSchema<RestartResult> = {
  idField: "action",
  columns: [
    {
      header: "STATUS",
      field: "action",
      color: () => "green",
    },
    { header: "HOME", field: "home" },
    { header: "PID", field: "pid" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type RestartCommandResult = SingleResult<RestartResult>;

function parseTimeoutMs(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_STOP_TIMEOUT_MS;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const error: CommandError = {
      code: "INVALID_TIMEOUT",
      message: `Invalid timeout value: ${raw}`,
      details: "Timeout must be a positive number of seconds",
    };
    throw error;
  }

  return Math.ceil(seconds * 1000);
}

function toStartOptions(options: CommandOptions): DaemonStartOptions {
  const startOptions: DaemonStartOptions = {
    home: typeof options.home === "string" ? options.home : undefined,
    listen: typeof options.listen === "string" ? options.listen : undefined,
    port: typeof options.port === "string" ? options.port : undefined,
    relay: typeof options.relay === "boolean" ? options.relay : undefined,
    mcp: typeof options.mcp === "boolean" ? options.mcp : undefined,
    injectMcp: typeof options.injectMcp === "boolean" ? options.injectMcp : undefined,
    webUi: typeof options.webUi === "boolean" ? options.webUi : undefined,
    hostnames: typeof options.hostnames === "string" ? options.hostnames : undefined,
  };

  if (startOptions.listen && startOptions.port) {
    const error: CommandError = {
      code: "INVALID_OPTIONS",
      message: "Cannot use --listen and --port together",
    };
    throw error;
  }

  return startOptions;
}

function resolveRestartMessage(
  stopResult: Awaited<ReturnType<typeof stopLocalDaemon>>,
  before: string,
  after: string,
): string {
  if (stopResult.reason === "not_running") {
    return `Local daemon started (${before} -> ${after})`;
  }
  if (stopResult.reason === "lifecycle_shutdown_rpc") {
    const mode = stopResult.forced ? "forceful" : "graceful";
    return `Local daemon restarted after ${mode} lifecycle shutdown (${before} -> ${after})`;
  }
  if (stopResult.reason === "owner_pid_sigkill") {
    return `Local daemon restarted after force-stopping the owner process (${before} -> ${after})`;
  }
  return `Local daemon restarted after owner PID signal (${before} -> ${after})`;
}

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
  runtime: RestartCommandRuntime = defaultRestartCommandRuntime,
): Promise<RestartCommandResult> {
  const timeoutMs = parseTimeoutMs(options.timeout);
  const force = options.force === true;
  const startOptions = toStartOptions(options);

  try {
    let stopResult: Awaited<ReturnType<typeof stopLocalDaemon>>;
    try {
      stopResult = await runtime.stopLocalDaemon({
        home: startOptions.home,
        timeoutMs,
        force,
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && err.message.includes("Timed out waiting for daemon PID");
      if (!force && isTimeout) {
        stopResult = await runtime.stopLocalDaemon({
          home: startOptions.home,
          timeoutMs,
          force: true,
        });
      } else {
        throw err;
      }
    }

    const startup = await runtime.startLocalDaemonDetached(startOptions);
    const before = stopResult.pid === null ? "not running" : `PID ${stopResult.pid}`;
    const after = startup.pid === null ? "unknown PID" : `PID ${startup.pid}`;

    return {
      type: "single",
      data: {
        action: "restarted",
        home: stopResult.home,
        pid: startup.pid === null ? "-" : String(startup.pid),
        forced: stopResult.forced,
        usedLifecycleRpc: stopResult.usedLifecycleRpc,
        reason: stopResult.reason,
        message: resolveRestartMessage(stopResult, before, after),
      },
      schema: restartResultSchema,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "RESTART_FAILED",
      message: `Failed to restart local daemon: ${message}`,
    };
    throw error;
  }
}
