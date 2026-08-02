import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeSpawnBehavior {
  delayMs?: number;
  deferCloseOnKill?: boolean;
  emitError?: Error;
  exitCode?: number | null;
  stderrData?: Buffer | string;
  stdoutData?: Buffer | string;
  throwError?: Error;
}

interface FakeSpawnController {
  activeCount: number;
  nextPid: number;
  peakActiveCount: number;
  processes: FakeChildProcess[];
  queue: FakeSpawnBehavior[];
  spawnedArgs: string[][];
  reset: () => void;
}

const fakeSpawnController = vi.hoisted<FakeSpawnController>(() => ({
  activeCount: 0,
  nextPid: 1000,
  peakActiveCount: 0,
  processes: [],
  queue: [],
  spawnedArgs: [],
  reset() {
    for (const process of this.processes) {
      process.dispose();
    }

    this.activeCount = 0;
    this.nextPid = 1000;
    this.peakActiveCount = 0;
    this.processes = [];
    this.queue = [];
    this.spawnedArgs = [];
  },
}));

class FakeChildProcess extends EventEmitter {
  public readonly pid: number;
  public readonly stderr = new EventEmitter();
  public readonly stdout = new EventEmitter();
  public killed = false;
  public killSignals: NodeJS.Signals[] = [];

  private readonly behavior: FakeSpawnBehavior;
  private readonly timers: NodeJS.Timeout[] = [];
  private closed = false;

  public constructor(behavior: FakeSpawnBehavior) {
    super();
    this.behavior = behavior;
    this.pid = fakeSpawnController.nextPid;
    fakeSpawnController.nextPid += 1;

    fakeSpawnController.activeCount += 1;
    fakeSpawnController.peakActiveCount = Math.max(
      fakeSpawnController.peakActiveCount,
      fakeSpawnController.activeCount,
    );

    this.scheduleLifecycle();
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.closed) return false;

    this.killed = true;
    this.killSignals.push(signal);
    this.clearTimers();
    if (this.behavior.deferCloseOnKill) {
      return true;
    }
    this.schedule(() => {
      this.finishClose({
        exitCode: null,
        signal,
      });
    }, 0);
    return true;
  }

  public closeKilledProcess(): void {
    const signal = this.killSignals.at(-1) ?? null;
    this.finishClose({ exitCode: null, signal });
  }

  public dispose(): void {
    this.clearTimers();
    this.closed = true;
  }

  private scheduleLifecycle(): void {
    const stdoutData = this.behavior.stdoutData;
    if (stdoutData !== undefined) {
      this.schedule(() => {
        if (this.closed) return;
        this.stdout.emit("data", stdoutData);
      }, 0);
    }

    const stderrData = this.behavior.stderrData;
    if (stderrData !== undefined) {
      this.schedule(() => {
        if (this.closed) return;
        this.stderr.emit("data", stderrData);
      }, 0);
    }

    if (this.behavior.emitError) {
      this.schedule(() => {
        if (this.closed) return;
        this.emit("error", this.behavior.emitError);
        this.schedule(() => {
          this.finishClose({ exitCode: null, signal: null });
        }, 0);
      }, this.behavior.delayMs ?? 0);
      return;
    }

    this.schedule(() => {
      this.finishClose({
        exitCode: this.behavior.exitCode ?? 0,
        signal: null,
      });
    }, this.behavior.delayMs ?? 0);
  }

  private finishClose({
    exitCode,
    signal,
  }: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    if (this.closed) return;

    this.closed = true;
    this.clearTimers();
    fakeSpawnController.activeCount -= 1;
    this.emit("close", exitCode, signal);
  }

  private schedule(callback: () => void, delayMs: number): void {
    const timer = setTimeout(callback, delayMs);
    this.timers.push(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.length = 0;
  }
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

  return {
    ...actual,
    spawn: vi.fn((_command: string, args: string[]) => {
      const behavior = fakeSpawnController.queue.shift() ?? {};
      fakeSpawnController.spawnedArgs.push(args);
      if (behavior.throwError) {
        throw behavior.throwError;
      }
      const child = new FakeChildProcess(behavior);
      fakeSpawnController.processes.push(child);
      return child as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

function enqueueSpawnBehaviors(...behaviors: FakeSpawnBehavior[]): void {
  fakeSpawnController.queue.push(...behaviors);
}

async function loadRunGitCommand(concurrency: number, maxPending?: number) {
  vi.resetModules();
  vi.stubEnv("PASEO_GIT_CONCURRENCY", String(concurrency));
  if (maxPending !== undefined) {
    vi.stubEnv("PASEO_GIT_MAX_PENDING", String(maxPending));
  }
  return import("./run-git-command.js");
}

async function loadRunGitCommandEnv(concurrency: string, maxPending: string) {
  vi.resetModules();
  vi.stubEnv("PASEO_GIT_CONCURRENCY", concurrency);
  vi.stubEnv("PASEO_GIT_MAX_PENDING", maxPending);
  return import("./run-git-command.js");
}

describe("runGitCommand", () => {
  beforeEach(() => {
    fakeSpawnController.reset();
  });

  afterEach(() => {
    fakeSpawnController.reset();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("throttles concurrent git commands to the configured limit", async () => {
    const { runGitCommand } = await loadRunGitCommand(2);

    enqueueSpawnBehaviors(...Array.from({ length: 16 }, () => ({ delayMs: 25 })));

    await Promise.all(
      Array.from({ length: 16 }, () =>
        runGitCommand(["rev-parse", "--show-toplevel"], {
          cwd: process.cwd(),
        }),
      ),
    );

    expect(fakeSpawnController.peakActiveCount).toBe(2);
    expect(fakeSpawnController.activeCount).toBe(0);
  });

  it("bounds pending admission across more than 100 targets and recovers on retry", async () => {
    const { GitCommandBackpressureError, runGitCommand, snapshotGitCommandRuntimeMetrics } =
      await loadRunGitCommand(2, 3);
    enqueueSpawnBehaviors(...Array.from({ length: 5 }, () => ({ delayMs: 25 })));

    const attempts = Array.from({ length: 128 }, (_, index) =>
      runGitCommand(["status", `target-${index}`], { cwd: process.cwd() }),
    );
    const outcomes = await Promise.allSettled(attempts);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
    const rejections = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejections).toHaveLength(123);
    expect(
      rejections.every(
        ({ reason }) =>
          reason instanceof GitCommandBackpressureError &&
          reason.retryable === true &&
          reason.maxPending === 3,
      ),
    ).toBe(true);
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
      maxPending: 3,
      peakPending: 3,
      submitted: 128,
      admitted: 5,
      rejected: 123,
    });

    enqueueSpawnBehaviors({ stdoutData: "recovered" });
    await expect(runGitCommand(["status", "retry"], { cwd: process.cwd() })).resolves.toMatchObject(
      { stdout: "recovered" },
    );
  });

  it.each([
    ["prefix", "8commands"],
    ["decimal", "8.5"],
    ["exponent", "1e1"],
    ["leading whitespace", " 8"],
    ["trailing whitespace", "8 "],
    ["unsafe integer", "9007199254740992"],
    ["zero", "0"],
    ["negative", "-1"],
    ["above cap", "33"],
  ])("falls back for invalid concurrency: %s", async (_label, value) => {
    const { snapshotGitCommandRuntimeMetrics } = await loadRunGitCommandEnv(value, "64");

    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({ concurrencyLimit: 8 });
  });

  it.each([
    ["prefix", "64commands"],
    ["decimal", "64.5"],
    ["exponent", "1e2"],
    ["leading whitespace", " 64"],
    ["trailing whitespace", "64 "],
    ["unsafe integer", "9007199254740992"],
    ["zero", "0"],
    ["negative", "-1"],
    ["above cap", "1025"],
  ])("falls back for invalid pending limit: %s", async (_label, value) => {
    const { snapshotGitCommandRuntimeMetrics } = await loadRunGitCommandEnv("8", value);

    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({ maxPending: 64 });
  });

  it.each([
    ["concurrency minimum", "1", "64", { concurrencyLimit: 1, maxPending: 64 }],
    ["concurrency maximum", "32", "64", { concurrencyLimit: 32, maxPending: 64 }],
    ["pending minimum", "8", "1", { concurrencyLimit: 8, maxPending: 1 }],
    ["pending maximum", "8", "1024", { concurrencyLimit: 8, maxPending: 1_024 }],
  ])("accepts the exact %s", async (_label, concurrency, maxPending, expected) => {
    const { snapshotGitCommandRuntimeMetrics } = await loadRunGitCommandEnv(
      concurrency,
      maxPending,
    );

    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject(expected);
  });

  it("keeps admitted commands in FIFO order while rejecting excess pressure", async () => {
    const { GitCommandBackpressureError, runGitCommand } = await loadRunGitCommand(1, 3);
    enqueueSpawnBehaviors(...Array.from({ length: 4 }, () => ({ delayMs: 10 })));

    const accepted = ["first", "second", "third", "fourth"].map((label) =>
      runGitCommand(["status", label], { cwd: process.cwd() }),
    );
    const rejected = runGitCommand(["status", "rejected"], { cwd: process.cwd() });

    await expect(rejected).rejects.toBeInstanceOf(GitCommandBackpressureError);
    await expect(Promise.all(accepted)).resolves.toHaveLength(4);
    expect(fakeSpawnController.spawnedArgs.map((args) => args.at(-1))).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("drains active and pending admitted commands", async () => {
    const { drainGitCommands, runGitCommand } = await loadRunGitCommand(1, 2);
    enqueueSpawnBehaviors(...Array.from({ length: 3 }, () => ({ delayMs: 20 })));
    const commands = ["first", "second", "third"].map((label) =>
      runGitCommand(["status", label], { cwd: process.cwd() }),
    );
    let drained = false;

    const drain = drainGitCommands().then(() => {
      drained = true;
      return undefined;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    await drain;
    await expect(Promise.all(commands)).resolves.toHaveLength(3);
    expect(drained).toBe(true);
    expect(fakeSpawnController.activeCount).toBe(0);
  });

  it("releases the physical executor before command settlement exposes a drain", async () => {
    const { drainGitCommands, runGitCommand, snapshotGitCommandRuntimeMetrics } =
      await loadRunGitCommand(1, 1);
    enqueueSpawnBehaviors({ stdoutData: "completed" }, { stdoutData: "retry" });

    const stateAtSettlement = await runGitCommand(["status", "completed"], {
      cwd: process.cwd(),
    }).then(() => ({
      drain: drainGitCommands(),
      metrics: snapshotGitCommandRuntimeMetrics(),
    }));

    expect(stateAtSettlement.metrics).toMatchObject({ active: 0, pending: 0 });
    await stateAtSettlement.drain;
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({ active: 0, pending: 0 });
    await expect(runGitCommand(["status", "retry"], { cwd: process.cwd() })).resolves.toMatchObject(
      { stdout: "retry" },
    );
  });

  it("keeps drain blocked when a settled command resumes a sequential producer", async () => {
    const { drainGitCommands, runGitCommand } = await loadRunGitCommand(1, 1);
    enqueueSpawnBehaviors(
      { stdoutData: "first" },
      { delayMs: 5_000, deferCloseOnKill: true, stdoutData: "second" },
    );

    const producer = (async () => {
      await runGitCommand(["status", "first"], { cwd: process.cwd() });
      await runGitCommand(["status", "second"], { cwd: process.cwd() });
    })();
    let drained = false;
    const drain = drainGitCommands().then(() => {
      drained = true;
      return undefined;
    });

    await vi.waitFor(() => expect(fakeSpawnController.spawnedArgs).toHaveLength(2));
    expect(drained).toBe(false);

    const secondProcess = fakeSpawnController.processes[1];
    expect(secondProcess).toBeDefined();
    secondProcess?.kill("SIGTERM");
    secondProcess?.closeKilledProcess();
    await expect(producer).rejects.toThrow("signal: SIGTERM");
    await drain;
    expect(drained).toBe(true);
  });

  it("kills timed out processes and releases the limiter slot", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors({ delayMs: 5_000 }, { delayMs: 0 });

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
        timeout: 100,
      }),
    ).rejects.toThrow("Git command timed out after 100ms: git status");

    expect(fakeSpawnController.processes[0]?.killed).toBe(true);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);

    await expect(
      runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      truncated: false,
    });
  });

  it("cancels active and queued git commands without starting the queued process", async () => {
    const { runGitCommand } = await loadRunGitCommand(1, 1);
    const activeController = new AbortController();
    const queuedController = new AbortController();

    enqueueSpawnBehaviors({ delayMs: 5_000 }, { delayMs: 0 });
    const active = runGitCommand(["status"], {
      cwd: process.cwd(),
      signal: activeController.signal,
    });
    await vi.waitFor(() => expect(fakeSpawnController.processes).toHaveLength(1));
    const queued = runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      signal: queuedController.signal,
    });

    queuedController.abort();
    await expect(queued).rejects.toThrow("Git command canceled: git rev-parse --show-toplevel");
    expect(fakeSpawnController.processes).toHaveLength(1);

    const replacement = runGitCommand(["status", "replacement"], { cwd: process.cwd() });

    activeController.abort();
    await expect(active).rejects.toThrow("Git command canceled: git status");
    await expect(replacement).resolves.toMatchObject({ exitCode: 0 });
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
    await vi.waitFor(() => expect(fakeSpawnController.activeCount).toBe(0));
    expect(fakeSpawnController.spawnedArgs.map((args) => args.at(-1))).toEqual([
      "status",
      "replacement",
    ]);

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    await expect(
      runGitCommand(["status", "--short"], {
        cwd: process.cwd(),
        signal: preAbortedController.signal,
      }),
    ).rejects.toThrow("Git command canceled: git status --short");
    await Promise.resolve();
    expect(fakeSpawnController.processes).toHaveLength(2);
  });

  it("releases a pre-aborted handoff reservation before the limiter callback runs", async () => {
    const { runGitCommand, snapshotGitCommandRuntimeMetrics } = await loadRunGitCommand(1, 1);
    const controller = new AbortController();
    enqueueSpawnBehaviors({ stdoutData: "replacement" });

    const canceled = runGitCommand(["status", "canceled"], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();
    const replacement = runGitCommand(["status", "replacement"], { cwd: process.cwd() });

    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement).resolves.toMatchObject({ stdout: "replacement" });
    expect(fakeSpawnController.spawnedArgs.map((args) => args.at(-1))).toEqual(["replacement"]);
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
      admitted: 2,
      canceled: 1,
      started: 1,
      completed: 1,
      failed: 0,
      active: 0,
      pending: 0,
    });
  });

  it("physically removes canceled queue entries during sustained churn", async () => {
    const { drainGitCommands, runGitCommand, snapshotGitCommandRuntimeMetrics } =
      await loadRunGitCommand(1, 1);
    const activeController = new AbortController();
    enqueueSpawnBehaviors(
      { delayMs: 5_000, deferCloseOnKill: true },
      { stdoutData: "replacement" },
      { stdoutData: "retry" },
    );

    const active = runGitCommand(["status", "active"], {
      cwd: process.cwd(),
      signal: activeController.signal,
    });
    await vi.waitFor(() => expect(fakeSpawnController.processes).toHaveLength(1));

    const cancellations: Promise<unknown>[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      const controller = new AbortController();
      const canceled = runGitCommand(["status", `canceled-${index}`], {
        cwd: process.cwd(),
        signal: controller.signal,
      });
      controller.abort();
      cancellations.push(canceled);
    }
    const outcomes = await Promise.allSettled(cancellations);

    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
      active: 1,
      pending: 0,
      canceled: 5_000,
    });

    const replacement = runGitCommand(["status", "replacement"], { cwd: process.cwd() });
    activeController.abort();
    fakeSpawnController.processes[0]?.closeKilledProcess();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    expect(fakeSpawnController.spawnedArgs.map((args) => args.at(-1))).toEqual([
      "active",
      "replacement",
    ]);
    await expect(replacement).resolves.toMatchObject({ stdout: "replacement" });
    await drainGitCommands();

    await expect(runGitCommand(["status", "retry"], { cwd: process.cwd() })).resolves.toMatchObject(
      { stdout: "retry" },
    );
  });

  it("settles repeated queued aborts once and never later spawns the command", async () => {
    const { drainGitCommands, runGitCommand, snapshotGitCommandRuntimeMetrics } =
      await loadRunGitCommand(1, 1);
    const activeController = new AbortController();
    const queuedController = new AbortController();
    enqueueSpawnBehaviors({ delayMs: 5_000 });

    const active = runGitCommand(["status", "active"], {
      cwd: process.cwd(),
      signal: activeController.signal,
    });
    await vi.waitFor(() => expect(fakeSpawnController.processes).toHaveLength(1));
    const queued = runGitCommand(["status", "queued"], {
      cwd: process.cwd(),
      signal: queuedController.signal,
    });

    queuedController.abort();
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    activeController.abort();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await drainGitCommands();

    expect(fakeSpawnController.spawnedArgs.map((args) => args.at(-1))).toEqual(["active"]);
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
      admitted: 2,
      canceled: 1,
      started: 1,
      completed: 1,
      failed: 1,
      active: 0,
      pending: 0,
    });
  });

  it("keeps an active cancellation pending until the killed process closes", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);
    const controller = new AbortController();

    enqueueSpawnBehaviors({ delayMs: 5_000, deferCloseOnKill: true });
    const command = runGitCommand(["worktree", "remove", "/tmp/example", "--force"], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    const observedRejection = vi.fn();
    void command.catch(observedRejection);
    await vi.waitFor(() => expect(fakeSpawnController.processes).toHaveLength(1));

    controller.abort();
    await Promise.resolve();

    expect(observedRejection).not.toHaveBeenCalled();
    expect(fakeSpawnController.activeCount).toBe(1);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);

    fakeSpawnController.processes[0]?.closeKilledProcess();

    await expect(command).rejects.toMatchObject({
      name: "AbortError",
      message: "Git command canceled: git worktree remove /tmp/example --force",
    });
    expect(observedRejection).toHaveBeenCalledOnce();
    expect(fakeSpawnController.activeCount).toBe(0);
  });

  it("resolves truncated stdout, caps output, and kills the child process", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors({
      delayMs: 5_000,
      stdoutData: "x".repeat(1_000),
    });

    const result = await runGitCommand(["log", "--all", "--oneline"], {
      cwd: process.cwd(),
      maxOutputBytes: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.stderr).toBe("");
    expect(fakeSpawnController.processes[0]?.killed).toBe(true);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
  });

  it("rejects process errors and frees the limiter for the next command", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);
    const spawnError = new Error("spawn exploded");

    enqueueSpawnBehaviors({ emitError: spawnError }, { delayMs: 0, stdoutData: "ok" });

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).rejects.toBe(spawnError);

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
      truncated: false,
    });
  });

  it("settles all metrics when spawn throws synchronously and preserves the error", async () => {
    const {
      drainGitCommands,
      runGitCommand,
      snapshotGitCommandRuntimeMetrics,
      startGitCommandMetrics,
      stopGitCommandMetrics,
    } = await loadRunGitCommand(1);
    const spawnError = new TypeError("spawn threw synchronously");
    startGitCommandMetrics();
    enqueueSpawnBehaviors({ throwError: spawnError });

    await expect(runGitCommand(["status"], { cwd: process.cwd() })).rejects.toBe(spawnError);
    await drainGitCommands();

    expect(stopGitCommandMetrics()).toMatchObject({
      total: 1,
      failed: 1,
      maxConcurrent: 1,
      commands: [
        expect.objectContaining({
          args: ["status"],
          exitCode: null,
          signal: null,
          success: false,
        }),
      ],
    });
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
      submitted: 1,
      admitted: 1,
      canceled: 0,
      started: 1,
      completed: 1,
      failed: 1,
      active: 0,
      pending: 0,
      queueWaitMs: { count: 1 },
      executionMs: { count: 1 },
    });
  });

  it("traces git command spawn and close metadata when a logger is provided", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);
    const trace = vi.fn();

    enqueueSpawnBehaviors({ delayMs: 0, stdoutData: "ok" });

    await expect(
      runGitCommand(["status", "--short"], {
        acceptExitCodes: [0, 1],
        cwd: process.cwd(),
        envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
        logger: { trace } as never,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
      truncated: false,
    });

    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git",
        args: ["status", "--short"],
        cwd: process.cwd(),
        cwdExists: true,
        timeout: 30_000,
        maxOutputBytes: 20 * 1024 * 1024,
        acceptExitCodes: [0, 1],
        envOverlayKeys: ["GIT_OPTIONAL_LOCKS"],
      }),
      "Spawning git command",
    );
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git",
        args: ["status", "--short"],
        cwd: process.cwd(),
        cwdExists: true,
        durationMs: expect.any(Number),
        exitCode: 0,
        signal: null,
        truncated: false,
        stdoutBytes: 2,
        stderrBytes: 0,
      }),
      "Git command closed",
    );
  });

  it("rejects non-zero exit codes that are not accepted and frees the slot", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors(
      {
        delayMs: 0,
        exitCode: 1,
        stderrData: "fatal: nope\n",
      },
      { delayMs: 0, stdoutData: "ok" },
    );

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/Git command failed: git status \(exit code: 1, signal: none\)/);

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
    });
  });

  it("resolves accepted non-zero exit codes", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors({
      delayMs: 0,
      exitCode: 1,
      stderrData: "fatal: but allowed\n",
    });

    await expect(
      runGitCommand(["status"], {
        acceptExitCodes: [0, 1],
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 1,
      signal: null,
      truncated: false,
    });
  });

  it("releases concurrency slots after timeouts so later commands can run", async () => {
    const { runGitCommand } = await loadRunGitCommand(2);

    enqueueSpawnBehaviors({ delayMs: 5_000 }, { delayMs: 5_000 });

    const firstBatch = await Promise.allSettled([
      runGitCommand(["status"], { cwd: process.cwd(), timeout: 100 }),
      runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        timeout: 100,
      }),
    ]);

    expect(firstBatch[0].status).toBe("rejected");
    expect(firstBatch[1].status).toBe("rejected");
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
    expect(fakeSpawnController.processes[1]?.killSignals).toEqual(["SIGKILL"]);

    enqueueSpawnBehaviors(
      { delayMs: 0, stdoutData: "third" },
      { delayMs: 0, stdoutData: "fourth" },
    );

    await expect(
      Promise.all([
        runGitCommand(["status"], { cwd: process.cwd() }),
        runGitCommand(["status"], { cwd: process.cwd() }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ exitCode: 0, stdout: "third" }),
      expect.objectContaining({ exitCode: 0, stdout: "fourth" }),
    ]);
  });

  it("releases concurrency slots after truncation so later commands can run", async () => {
    const { runGitCommand } = await loadRunGitCommand(2);

    enqueueSpawnBehaviors(
      { delayMs: 5_000, stdoutData: "a".repeat(1_000) },
      { delayMs: 5_000, stdoutData: "b".repeat(1_000) },
    );

    const firstBatch = await Promise.all([
      runGitCommand(["log", "--all", "--oneline"], {
        cwd: process.cwd(),
        maxOutputBytes: 100,
      }),
      runGitCommand(["log", "--all", "--oneline"], {
        cwd: process.cwd(),
        maxOutputBytes: 100,
      }),
    ]);

    expect(firstBatch).toEqual([
      expect.objectContaining({ truncated: true }),
      expect.objectContaining({ truncated: true }),
    ]);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
    expect(fakeSpawnController.processes[1]?.killSignals).toEqual(["SIGKILL"]);

    enqueueSpawnBehaviors(
      { delayMs: 0, stdoutData: "third" },
      { delayMs: 0, stdoutData: "fourth" },
    );

    await expect(
      Promise.all([
        runGitCommand(["status"], { cwd: process.cwd() }),
        runGitCommand(["status"], { cwd: process.cwd() }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ exitCode: 0, stdout: "third", truncated: false }),
      expect.objectContaining({ exitCode: 0, stdout: "fourth", truncated: false }),
    ]);
  });
});

describe("resolveGitExecutable", () => {
  it("uses a known absolute POSIX Git when daemon PATH lookup is unavailable", async () => {
    const { resolveGitExecutable } = await loadRunGitCommand(1);
    expect(
      resolveGitExecutable({
        env: { PATH: "" },
        platform: "darwin",
        exists: (candidate) => candidate === "/usr/bin/git",
      }),
    ).toBe("/usr/bin/git");
  });

  it("honors an explicitly configured Git executable", async () => {
    const { resolveGitExecutable } = await loadRunGitCommand(1);
    expect(
      resolveGitExecutable({
        env: { PASEO_GIT_EXECUTABLE: "/custom/git" },
        platform: "darwin",
        exists: () => false,
      }),
    ).toBe("/custom/git");
  });
});
