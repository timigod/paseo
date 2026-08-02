import { describe, expect, test } from "vitest";
import { render } from "../../output/index.js";
import type {
  DaemonStartOptions,
  StopLocalDaemonOptions,
  StopLocalDaemonResult,
} from "./local-daemon.js";
import { runRestartCommand, type RestartCommandRuntime } from "./restart.js";

class FakeRestartCommandRuntime implements RestartCommandRuntime {
  readonly stopOptions: StopLocalDaemonOptions[] = [];
  readonly startOptions: DaemonStartOptions[] = [];

  constructor(private readonly stopResult: StopLocalDaemonResult) {}

  async stopLocalDaemon(options: StopLocalDaemonOptions): Promise<StopLocalDaemonResult> {
    this.stopOptions.push(options);
    return this.stopResult;
  }

  async startLocalDaemonDetached(options: DaemonStartOptions) {
    this.startOptions.push(options);
    return { pid: 202, logPath: "/tmp/paseo/daemon.log" };
  }
}

describe("daemon restart command", () => {
  test("preserves forceful lifecycle shutdown details in JSON and human receipts", async () => {
    const runtime = new FakeRestartCommandRuntime({
      action: "stopped",
      home: "/tmp/paseo",
      pid: 101,
      forced: true,
      usedLifecycleRpc: true,
      reason: "lifecycle_shutdown_rpc",
      message: "Daemon stopped via forceful lifecycle shutdown",
    });

    const result = await runRestartCommand({ home: "/tmp/paseo" }, null as never, runtime);

    expect(result.data).toEqual({
      action: "restarted",
      home: "/tmp/paseo",
      pid: "202",
      forced: true,
      usedLifecycleRpc: true,
      reason: "lifecycle_shutdown_rpc",
      message: "Local daemon restarted after forceful lifecycle shutdown (PID 101 -> PID 202)",
    });
    expect(JSON.parse(render(result, { format: "json" }))).toEqual(result.data);
    expect(render(result, { format: "table", noColor: true })).toContain(
      "Local daemon restarted after forceful lifecycle shutdown (PID 101 -> PID 202)",
    );
    expect(runtime.stopOptions).toEqual([{ home: "/tmp/paseo", timeoutMs: 15_000, force: false }]);
    expect(runtime.startOptions).toEqual([{ home: "/tmp/paseo" }]);
  });

  test("reports graceful lifecycle shutdown in the human receipt", async () => {
    const runtime = new FakeRestartCommandRuntime({
      action: "stopped",
      home: "/tmp/paseo",
      pid: 101,
      forced: false,
      usedLifecycleRpc: true,
      reason: "lifecycle_shutdown_rpc",
      message: "Daemon stopped gracefully",
    });

    const result = await runRestartCommand({ home: "/tmp/paseo" }, null as never, runtime);

    expect(result.data.message).toBe(
      "Local daemon restarted after graceful lifecycle shutdown (PID 101 -> PID 202)",
    );
    expect(render(result, { format: "table", noColor: true })).toContain(
      "Local daemon restarted after graceful lifecycle shutdown (PID 101 -> PID 202)",
    );
  });

  test("reports owner force-stop after a lifecycle request without mislabeling it", async () => {
    const runtime = new FakeRestartCommandRuntime({
      action: "stopped",
      home: "/tmp/paseo",
      pid: 101,
      forced: true,
      usedLifecycleRpc: true,
      reason: "owner_pid_sigkill",
      message: "Daemon owner process was force-stopped",
    });

    const result = await runRestartCommand({ home: "/tmp/paseo" }, null as never, runtime);

    expect(result.data).toEqual({
      action: "restarted",
      home: "/tmp/paseo",
      pid: "202",
      forced: true,
      usedLifecycleRpc: true,
      reason: "owner_pid_sigkill",
      message: "Local daemon restarted after force-stopping the owner process (PID 101 -> PID 202)",
    });
    expect(JSON.parse(render(result, { format: "json" }))).toEqual(result.data);
    expect(render(result, { format: "table", noColor: true })).toContain(
      "Local daemon restarted after force-stopping the owner process (PID 101 -> PID 202)",
    );
  });
});
