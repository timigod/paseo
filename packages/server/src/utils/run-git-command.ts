import { existsSync } from "node:fs";
import type { Logger } from "pino";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import {
  GitCommandRuntimeMetricsWindow,
  type GitCommandRuntimeMetricsSnapshot,
} from "./git-command-runtime-metrics.js";
import { spawnProcess } from "./spawn.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_STDERR_LIMIT = 2048;
const DEFAULT_MAX_PENDING = 64;
const MAX_GIT_CONCURRENCY = 32;
const MAX_GIT_PENDING = 1_024;
const POSIX_GIT_CANDIDATES = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

const gitConcurrency = parseIntegerEnv("PASEO_GIT_CONCURRENCY", 8, 1, MAX_GIT_CONCURRENCY);
const gitMaxPending = parseIntegerEnv(
  "PASEO_GIT_MAX_PENDING",
  DEFAULT_MAX_PENDING,
  1,
  MAX_GIT_PENDING,
);
const gitRuntimeMetrics = new GitCommandRuntimeMetricsWindow(
  gitConcurrency,
  Date.now,
  gitMaxPending,
);

export function resolveGitExecutable(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: typeof existsSync;
}): string {
  const env = options?.env ?? process.env;
  const configured = env.PASEO_GIT_EXECUTABLE?.trim();
  if (configured) return configured;

  if ((options?.platform ?? process.platform) !== "win32") {
    const exists = options?.exists ?? existsSync;
    const absolute = POSIX_GIT_CANDIDATES.find((candidate) => exists(candidate));
    if (absolute) return absolute;
  }
  return "git";
}

export interface GitCommandOptions {
  cwd: string;
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
  logger?: Pick<Logger, "trace">;
  timeout?: number;
  maxOutputBytes?: number;
  acceptExitCodes?: number[];
  signal?: AbortSignal;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface GitExecutorEntry {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface SubmittedGitTask<T> {
  promise: Promise<T>;
  cancel: (error: Error) => boolean;
}

class GitCommandExecutor {
  private readonly starting: GitExecutorEntry[] = [];
  private readonly queue: GitExecutorEntry[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private runningCount = 0;
  private pumpScheduled = false;

  constructor(private readonly concurrency: number) {}

  get activeCount(): number {
    return this.runningCount + this.starting.length;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get admittedCount(): number {
    return this.activeCount + this.pendingCount;
  }

  async drain(): Promise<void> {
    while (!this.isIdle()) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
  }

  submit<T>(run: () => Promise<T>): SubmittedGitTask<T> {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry: GitExecutorEntry = {
      run,
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
    };
    if (this.activeCount < this.concurrency) {
      this.starting.push(entry);
    } else {
      this.queue.push(entry);
    }
    this.schedulePump();

    return {
      promise,
      cancel: (error) => {
        const startingIndex = this.starting.indexOf(entry);
        const queueIndex = this.queue.indexOf(entry);
        if (startingIndex < 0 && queueIndex < 0) return false;
        if (startingIndex >= 0) {
          this.starting.splice(startingIndex, 1);
          this.promotePending();
        } else {
          this.queue.splice(queueIndex, 1);
        }
        this.schedulePump();
        entry.reject(error);
        this.resolveIdleWaiters();
        return true;
      },
    };
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.starting.length === 0) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
      this.resolveIdleWaiters();
    });
  }

  private pump(): void {
    while (this.runningCount < this.concurrency) {
      const entry = this.starting.shift();
      if (!entry) return;
      this.runningCount += 1;

      let task: Promise<unknown>;
      try {
        task = entry.run();
      } catch (error) {
        this.finishTask();
        entry.reject(error);
        this.resolveIdleWaiters();
        continue;
      }
      void task.then(
        (value) => {
          this.finishTask();
          entry.resolve(value);
          this.resolveIdleWaiters();
          return undefined;
        },
        (error) => {
          this.finishTask();
          entry.reject(error);
          this.resolveIdleWaiters();
          return undefined;
        },
      );
    }
  }

  private finishTask(): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.promotePending();
    this.schedulePump();
  }

  private promotePending(): void {
    while (this.activeCount < this.concurrency) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.starting.push(entry);
    }
  }

  private isIdle(): boolean {
    return this.admittedCount === 0 && !this.pumpScheduled;
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

const gitExecutor = new GitCommandExecutor(gitConcurrency);

export interface GitCommandMetric {
  args: string[];
  cwd: string;
  startedAtMs: number;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  success: boolean;
}

export interface GitCommandMetricsSnapshot {
  commands: GitCommandMetric[];
  total: number;
  failed: number;
  maxConcurrent: number;
}

export class GitCommandBackpressureError extends Error {
  readonly kind = "git-command-backpressure";
  readonly retryable = true;

  constructor(
    readonly active: number,
    readonly pending: number,
    readonly concurrencyLimit: number,
    readonly maxPending: number,
  ) {
    super(`Git command queue is full (${pending}/${maxPending} pending)`);
    this.name = "GitCommandBackpressureError";
  }
}

export function throwIfGitCommandBackpressure(error: unknown): void {
  if (error instanceof GitCommandBackpressureError) {
    throw error;
  }
}

interface GitCommandMetricsState {
  commands: GitCommandMetric[];
  active: number;
  maxConcurrent: number;
}

let gitCommandMetricsState: GitCommandMetricsState | null = null;

export function startGitCommandMetrics(): void {
  gitCommandMetricsState = {
    commands: [],
    active: 0,
    maxConcurrent: 0,
  };
}

export function stopGitCommandMetrics(): GitCommandMetricsSnapshot {
  const state = gitCommandMetricsState;
  gitCommandMetricsState = null;
  if (!state) {
    return {
      commands: [],
      total: 0,
      failed: 0,
      maxConcurrent: 0,
    };
  }
  return {
    commands: [...state.commands],
    total: state.commands.length,
    failed: state.commands.filter((command) => !command.success).length,
    maxConcurrent: state.maxConcurrent,
  };
}

export function snapshotGitCommandRuntimeMetrics(): GitCommandRuntimeMetricsSnapshot {
  return gitRuntimeMetrics.snapshotAndReset({
    active: gitExecutor.activeCount,
    pending: gitExecutor.pendingCount,
  });
}

/** Wait for the global executor to release every command and scheduled pump. */
export async function drainGitCommands(): Promise<void> {
  await gitExecutor.drain();
}

function beginGitCommandMetric(): GitCommandMetricsState | null {
  const state = gitCommandMetricsState;
  if (!state) {
    return null;
  }
  state.active += 1;
  state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
  return state;
}

function finishGitCommandMetric(
  state: GitCommandMetricsState | null,
  metric: GitCommandMetric,
): void {
  if (!state) {
    return;
  }
  state.active = Math.max(0, state.active - 1);
  state.commands.push(metric);
}

function mergeEnvOverlays(
  env: ProcessEnvRecord | undefined,
  envOverlay: ProcessEnvRecord | undefined,
): ProcessEnvRecord | undefined {
  if (!env) {
    return envOverlay;
  }
  if (!envOverlay) {
    return env;
  }
  return { ...env, ...envOverlay };
}

function getEnvOverlayKeys(envOverlay: ProcessEnvRecord | undefined): string[] {
  return Object.keys(envOverlay ?? {}).sort();
}

function createGitCancellationError(args: readonly string[]): Error {
  const error = new Error(`Git command canceled: ${formatGitCommand(args)}`);
  error.name = "AbortError";
  return error;
}

function waitForGitCommand<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  cancelQueued: () => Error | null,
): Promise<T> {
  if (!signal) return task;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      const error = cancelQueued();
      if (error) finish(() => reject(error));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

export function runGitCommand(
  args: string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  const operation = getGitOperation(args);
  const active = gitExecutor.activeCount;
  const pending = gitExecutor.pendingCount;
  if (gitExecutor.admittedCount >= gitConcurrency + gitMaxPending) {
    gitRuntimeMetrics.reject(operation);
    gitRuntimeMetrics.observeLimiter(active, pending);
    return Promise.reject(
      new GitCommandBackpressureError(active, pending, gitConcurrency, gitMaxPending),
    );
  }

  const runtimeMetric = gitRuntimeMetrics.submit(operation);
  const cancellationError = createGitCancellationError(args);
  const submitted = gitExecutor.submit(() => {
    if (options.signal?.aborted) {
      gitRuntimeMetrics.start(runtimeMetric);
      gitRuntimeMetrics.finish(runtimeMetric, { success: false, timedOut: false });
      throw cancellationError;
    }
    return new Promise<GitCommandResult>((resolve, reject) => {
      gitRuntimeMetrics.start(runtimeMetric);
      const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const acceptExitCodes = options.acceptExitCodes ?? [0];
      const command = formatGitCommand(args);
      const envOverlay = mergeEnvOverlays(options.env, options.envOverlay);
      const startedAt = Date.now();
      const metricsState = beginGitCommandMetric();
      const logger = typeof options.logger?.trace === "function" ? options.logger : undefined;
      const traceContext = logger
        ? {
            command: "git",
            args,
            cwd: options.cwd,
            cwdExists: existsSync(options.cwd),
            timeout,
            maxOutputBytes,
            acceptExitCodes,
            envOverlayKeys: getEnvOverlayKeys(envOverlay),
          }
        : null;

      if (logger && traceContext) {
        logger.trace(traceContext, "Spawning git command");
      }

      let settled = false;
      let metricFinished = false;
      let pendingError: Error | null = null;
      let pendingErrorTimedOut = false;
      let requestedSignal: NodeJS.Signals | null = null;
      let truncated = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };

      const finishMetricOnce = (metric: GitCommandMetric, timedOut = false) => {
        if (metricFinished) return;
        metricFinished = true;
        finishGitCommandMetric(metricsState, metric);
        gitRuntimeMetrics.finish(runtimeMetric, { success: metric.success, timedOut });
      };

      let child: ReturnType<typeof spawnProcess>;
      try {
        // `core.quotepath=false` makes git emit raw UTF-8 paths instead of
        // octal-escaping non-ASCII bytes (e.g. `测试文件.txt` vs `"\346\265\213..."`).
        child = spawnProcess(resolveGitExecutable(), ["-c", "core.quotepath=false", ...args], {
          cwd: options.cwd,
          envOverlay,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finishMetricOnce({
          args,
          cwd: options.cwd,
          startedAtMs: startedAt,
          durationMs: Date.now() - startedAt,
          exitCode: null,
          signal: null,
          success: false,
        });
        reject(error);
        return;
      }

      const rememberError = (error: Error, timedOut = false) => {
        if (pendingError) return;
        pendingError = error;
        pendingErrorTimedOut = timedOut;
      };

      const requestTermination = (error: Error, timedOut = false) => {
        rememberError(error, timedOut);
        if (requestedSignal) return;
        requestedSignal = "SIGKILL";
        child.kill(requestedSignal);
      };

      const timer = setTimeout(() => {
        const error = new Error(`Git command timed out after ${timeout}ms: ${command}`);
        requestTermination(error, true);
      }, timeout);

      const onAbort = () => {
        requestTermination(createGitCancellationError(args));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();

      child.stdout!.on("data", (chunk: Buffer | string) => {
        if (settled || truncated) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = maxOutputBytes - stdoutBytes;

        if (remainingBytes <= 0) {
          truncated = true;
          child.kill("SIGKILL");
          return;
        }

        if (buffer.length > remainingBytes) {
          stdoutChunks.push(buffer.subarray(0, remainingBytes));
          stdoutBytes += remainingBytes;
          truncated = true;
          child.kill("SIGKILL");
          return;
        }

        stdoutChunks.push(buffer);
        stdoutBytes += buffer.length;
      });

      child.stderr!.on("data", (chunk: Buffer | string) => {
        if (settled || stderrBytes >= DEFAULT_STDERR_LIMIT) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = DEFAULT_STDERR_LIMIT - stderrBytes;

        if (buffer.length > remainingBytes) {
          stderrChunks.push(buffer.subarray(0, remainingBytes));
          stderrBytes += remainingBytes;
          return;
        }

        stderrChunks.push(buffer);
        stderrBytes += buffer.length;
      });

      child.on("error", (error) => {
        rememberError(error);
        if (logger && traceContext) {
          logger.trace(
            {
              ...traceContext,
              err: error,
              durationMs: Date.now() - startedAt,
            },
            "Git command process error",
          );
        }
      });

      child.on("close", (exitCode, signal) => {
        const result: GitCommandResult = {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated,
          exitCode,
          signal,
        };
        if (logger && traceContext) {
          logger.trace(
            {
              ...traceContext,
              durationMs: Date.now() - startedAt,
              exitCode,
              signal,
              truncated,
              stdoutBytes,
              stderrBytes,
            },
            "Git command closed",
          );
        }

        if (pendingError) {
          const error = pendingError;
          finishMetricOnce(
            {
              args,
              cwd: options.cwd,
              startedAtMs: startedAt,
              durationMs: Date.now() - startedAt,
              exitCode,
              signal: signal ?? requestedSignal,
              success: false,
            },
            pendingErrorTimedOut,
          );
          settle(() => reject(error));
          return;
        }

        if (!truncated && !acceptExitCodes.includes(exitCode ?? -1)) {
          finishMetricOnce({
            args,
            cwd: options.cwd,
            startedAtMs: startedAt,
            durationMs: Date.now() - startedAt,
            exitCode,
            signal,
            success: false,
          });
          const stderrPreview = result.stderr.trim() || "(no stderr)";
          const truncationNote = result.truncated ? " (stdout truncated)" : "";

          settle(() =>
            reject(
              new Error(
                `Git command failed: ${command}${truncationNote} (exit code: ${String(exitCode)}, signal: ${signal ?? "none"})\n${stderrPreview}`,
              ),
            ),
          );
          return;
        }

        finishMetricOnce({
          args,
          cwd: options.cwd,
          startedAtMs: startedAt,
          durationMs: Date.now() - startedAt,
          exitCode,
          signal,
          success: true,
        });
        settle(() => resolve(result));
      });
    });
  });
  const promise = submitted.promise;
  const cancelQueued = (): Error | null => {
    if (!submitted.cancel(cancellationError)) return null;
    gitRuntimeMetrics.cancel(runtimeMetric);
    gitRuntimeMetrics.observeLimiter(gitExecutor.activeCount, gitExecutor.pendingCount);
    return cancellationError;
  };
  gitRuntimeMetrics.observeLimiter(gitExecutor.activeCount, gitExecutor.pendingCount);
  return waitForGitCommand(promise, options.signal, cancelQueued);
}

function formatGitCommand(args: readonly string[]): string {
  return ["git", ...args].join(" ");
}

function getGitOperation(args: string[]): string {
  return args[0] === "-c" ? (args[2] ?? "unknown") : (args[0] ?? "unknown");
}

function parseIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
