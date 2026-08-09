import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => Promise<void>;
}

export interface OpenCodeServerAcquisitionOptions {
  deadlineAtMs?: number;
  timeoutMessage?: string;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(options?: OpenCodeServerAcquisitionOptions): Promise<OpenCodeServerAcquisition>;
  acquireNew(options?: OpenCodeServerAcquisitionOptions): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  shutdown(): Promise<void>;
}

export interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
}

interface OpenCodeServerStartup {
  controller: AbortController;
  promise: Promise<OpenCodeServerGeneration>;
  server: OpenCodeServerGeneration | null;
  waiterCount: number;
  published: boolean;
}

class OpenCodeServerAcquisitionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeServerAcquisitionTimeoutError";
  }
}

export type OpenCodePortAllocator = () => Promise<number>;
export type OpenCodeCommandPrefixResolver = () => Promise<{ command: string; args: string[] }>;
export type OpenCodeServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export interface OpenCodeServerManagerOptions {
  logger: Logger;
  baseEnv?: SpawnProcessOptions["baseEnv"];
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodePortAllocator;
  resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
  resolveHomeDir?: () => string;
  spawnServerProcess?: OpenCodeServerProcessSpawner;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private currentStartup: OpenCodeServerStartup | null = null;
  private newServerStartup: OpenCodeServerStartup | null = null;
  private readonly logger: Logger;
  private readonly baseEnv?: SpawnProcessOptions["baseEnv"];
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: OpenCodePortAllocator;
  private readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver;
  private readonly resolveHomeDir: () => string;
  private readonly spawnServerProcess: OpenCodeServerProcessSpawner;

  constructor(options: OpenCodeServerManagerOptions) {
    this.logger = options.logger;
    this.baseEnv = options.baseEnv;
    this.runtimeSettings = options.runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(this.runtimeSettings ?? {});
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.portAllocator = options.portAllocator ?? findAvailablePort;
    this.resolveCommandPrefix =
      options.resolveCommandPrefix ??
      (() => resolveProviderCommandPrefix(this.runtimeSettings?.command, resolveOpenCodeBinary));
    this.resolveHomeDir = options.resolveHomeDir ?? resolveOpenCodeHomeDir;
    this.spawnServerProcess = options.spawnServerProcess ?? spawnProcess;
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager({
        logger,
        runtimeSettings,
        ...options,
      });
      OpenCodeServerManager.registerExitHandler();
    } else if (OpenCodeServerManager.instance.runtimeSettingsKey !== nextSettingsKey) {
      logger.warn(
        {
          existingRuntimeSettings: OpenCodeServerManager.instance.runtimeSettingsKey,
          requestedRuntimeSettings: nextSettingsKey,
        },
        "OpenCode server manager already initialized with different runtime settings",
      );
    }
    return OpenCodeServerManager.instance;
  }

  private static registerExitHandler(): void {
    if (OpenCodeServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      const instance = OpenCodeServerManager.instance;
      void instance?.shutdown();
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async acquireCurrent(
    options?: OpenCodeServerAcquisitionOptions,
  ): Promise<OpenCodeServerAcquisition> {
    this.throwIfAcquisitionTimedOut(options);
    const startup = this.getCurrentServerStartup();
    if (startup) {
      return this.acquireFromStartup(startup, options);
    }
    const server = this.currentServer;
    if (!server) {
      throw new Error("OpenCode current server was not available");
    }
    this.throwIfAcquisitionTimedOut(options);
    return this.acquireServer(server);
  }

  async acquireNew(options?: OpenCodeServerAcquisitionOptions): Promise<OpenCodeServerAcquisition> {
    this.throwIfAcquisitionTimedOut(options);
    if (this.currentStartup && !this.newServerStartup) {
      const currentAcquisition = await this.acquireFromStartup(this.currentStartup, options);
      await currentAcquisition.release();
      this.throwIfAcquisitionTimedOut(options);
    }
    return this.acquireFromStartup(this.getNewServerStartup(), options);
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    const server = await this.startServer(env);
    server.retired = true;
    this.retiredServers.add(server);
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  private findLiveServerByUrl(url: string): OpenCodeServerGeneration | null {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    return servers.find((server) => server.url === url && this.isServerLive(server)) ?? null;
  }

  private isServerLive(server: OpenCodeServerGeneration): boolean {
    return (
      !server.process.killed &&
      server.process.exitCode === null &&
      server.process.signalCode === null
    );
  }

  private acquireServer(server: OpenCodeServerGeneration): OpenCodeServerAcquisition {
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: { port: server.port, url: server.url },
      release: async () => {
        if (releasePromise) {
          return releasePromise;
        }
        releasePromise = this.releaseServer(server);
        return releasePromise;
      },
    };
  }

  private async releaseServer(server: OpenCodeServerGeneration): Promise<void> {
    server.refCount = Math.max(0, server.refCount - 1);
    if (server.refCount > 0) {
      return;
    }

    if (this.currentServer === server) {
      this.currentServer = null;
      server.retired = true;
    }
    if (!server.retired) {
      return;
    }

    this.retiredServers.delete(server);
    await this.killServer(server);
  }

  private getNewServerStartup(): OpenCodeServerStartup {
    if (this.newServerStartup) {
      return this.newServerStartup;
    }
    const startup = this.createServerStartup();
    this.newServerStartup = startup;
    return startup;
  }

  private getCurrentServerStartup(): OpenCodeServerStartup | null {
    if (this.newServerStartup) {
      return this.newServerStartup;
    }
    if (this.currentStartup) {
      return this.currentStartup;
    }
    if (this.currentServer && this.isServerLive(this.currentServer)) {
      return null;
    }
    const startup = this.createServerStartup();
    this.currentStartup = startup;
    return startup;
  }

  private createServerStartup(): OpenCodeServerStartup {
    const controller = new AbortController();
    let startup: OpenCodeServerStartup;
    const promise = this.startServer(undefined, controller.signal).then(async (server) => {
      startup.server = server;
      await server.ready;
      if (controller.signal.aborted) {
        throw this.readStartupAbortReason(controller.signal);
      }
      return server;
    });
    startup = {
      controller,
      promise,
      server: null,
      waiterCount: 0,
      published: false,
    };
    startup.promise = promise.catch((error: unknown) => {
      this.clearStartup(startup);
      throw error;
    });
    return startup;
  }

  private async acquireFromStartup(
    startup: OpenCodeServerStartup,
    options?: OpenCodeServerAcquisitionOptions,
  ): Promise<OpenCodeServerAcquisition> {
    startup.waiterCount += 1;
    let waiterReleased = false;
    try {
      const server = await this.waitForStartup(startup.promise, options);
      this.throwIfAcquisitionTimedOut(options);
      if (startup.controller.signal.aborted) {
        throw this.readStartupAbortReason(startup.controller.signal);
      }
      const acquisition = this.acquireServer(server);
      this.publishStartup(startup, server);
      return acquisition;
    } catch (error) {
      if (error instanceof OpenCodeServerAcquisitionTimeoutError) {
        startup.waiterCount = Math.max(0, startup.waiterCount - 1);
        waiterReleased = true;
        if (startup.waiterCount === 0 && !startup.published) {
          await this.cancelStartup(startup, error);
        }
      }
      throw error;
    } finally {
      if (!waiterReleased) {
        startup.waiterCount = Math.max(0, startup.waiterCount - 1);
      }
    }
  }

  private publishStartup(startup: OpenCodeServerStartup, server: OpenCodeServerGeneration): void {
    if (startup.published) {
      return;
    }
    const previous = this.currentServer;
    if (previous && previous !== server) {
      previous.retired = true;
      this.retiredServers.add(previous);
    }
    server.retired = false;
    this.currentServer = server;
    startup.published = true;
    this.clearStartup(startup);
  }

  private async cancelStartup(startup: OpenCodeServerStartup, error: Error): Promise<void> {
    startup.controller.abort(error);
    this.clearStartup(startup);
    await startup.promise.catch(() => undefined);
    if (startup.server && this.isServerLive(startup.server)) {
      await this.killServer(startup.server);
    }
  }

  private clearStartup(startup: OpenCodeServerStartup): void {
    if (this.currentStartup === startup) {
      this.currentStartup = null;
    }
    if (this.newServerStartup === startup) {
      this.newServerStartup = null;
    }
  }

  private waitForStartup(
    promise: Promise<OpenCodeServerGeneration>,
    options?: OpenCodeServerAcquisitionOptions,
  ): Promise<OpenCodeServerGeneration> {
    this.throwIfAcquisitionTimedOut(options);
    const deadlineAtMs = options?.deadlineAtMs;
    if (deadlineAtMs === undefined) {
      return promise;
    }
    const timeoutMessage = options?.timeoutMessage ?? "OpenCode server acquisition timed out";
    return new Promise<OpenCodeServerGeneration>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        operation();
      };
      const timeout = setTimeout(
        () => finish(() => reject(new OpenCodeServerAcquisitionTimeoutError(timeoutMessage))),
        Math.max(0, deadlineAtMs - Date.now()),
      );
      promise.then(
        (server) => finish(() => resolve(server)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private throwIfAcquisitionTimedOut(options?: OpenCodeServerAcquisitionOptions): void {
    if (options?.deadlineAtMs !== undefined && options.deadlineAtMs <= Date.now()) {
      throw new OpenCodeServerAcquisitionTimeoutError(
        options.timeoutMessage ?? "OpenCode server acquisition timed out",
      );
    }
  }

  private readStartupAbortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error("OpenCode server terminated during startup");
  }

  private async startServer(
    launchEnv?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerGeneration> {
    if (signal?.aborted) {
      throw this.readStartupAbortReason(signal);
    }
    const port = await this.portAllocator();
    if (signal?.aborted) {
      throw this.readStartupAbortReason(signal);
    }
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.resolveCommandPrefix();
    if (signal?.aborted) {
      throw this.readStartupAbortReason(signal);
    }
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    const serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
      cwd: serverCwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        baseEnv: this.baseEnv,
        runtimeSettings: this.runtimeSettings,
        overlays: [launchEnv],
      }),
    });
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchPrefix.command,
      args: serverArgs,
      port,
    });
    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      refCount: 0,
      retired: false,
      ready: Promise.resolve(),
      managedProcessRecord,
    };
    void managedProcessRecord.then((record) => {
      if (record && server.managedProcessRecord === managedProcessRecord) {
        server.managedProcessId = record.id;
      }
      return undefined;
    });

    let started = false;
    let settled = false;
    let stderrBuffer = "";
    let stdoutBuffer = "";
    const STARTUP_BUFFER_CAP = 8192;
    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= STARTUP_BUFFER_CAP) {
        return current;
      }
      const remaining = STARTUP_BUFFER_CAP - current.length;
      return current + chunk.slice(0, remaining);
    };
    const buildStartupErrorMessage = (headline: string): string => {
      const sections = [headline];
      const stderrTrimmed = stderrBuffer.trim();
      if (stderrTrimmed.length > 0) {
        sections.push(`stderr: ${stderrTrimmed}`);
      }
      const stdoutTrimmed = stdoutBuffer.trim();
      if (stdoutTrimmed.length > 0) {
        sections.push(`stdout: ${stdoutTrimmed}`);
      }
      return sections.join("\n");
    };

    const ready = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      let abortFromSignal: (() => void) | undefined;
      const failStartup = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (abortFromSignal) {
          signal?.removeEventListener("abort", abortFromSignal);
        }
        reject(error);
      };
      abortFromSignal = () => failStartup(this.readStartupAbortReason(signal!));
      signal?.addEventListener("abort", abortFromSignal, { once: true });
      timeout = setTimeout(() => {
        if (!started) {
          failStartup(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !settled) {
          started = true;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abortFromSignal!);
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode server stderr");
      });

      serverProcess.on("error", (error) => {
        const headline = error instanceof Error ? error.message : String(error);
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        this.removeManagedServerRecord(server);
        if (!started) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)),
          );
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess) {
            this.retiredServers.delete(retired);
          }
        }
      });
      if (signal?.aborted) {
        abortFromSignal();
      }
    });

    server.ready = ready.catch(async (error) => {
      await this.killServer(server);
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      this.retiredServers.delete(server);
      throw error;
    });

    return server;
  }

  async shutdown(): Promise<void> {
    const startups = [this.currentStartup, this.newServerStartup].filter(
      (startup): startup is OpenCodeServerStartup => startup !== null,
    );
    const servers = new Set([
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
      ...startups.flatMap((startup) => (startup.server ? [startup.server] : [])),
    ]);
    for (const startup of startups) {
      this.clearStartup(startup);
      if (startup.server) {
        await this.killServer(startup.server);
      }
      startup.controller.abort(new Error("OpenCode server terminated during startup"));
    }
    await Promise.allSettled(startups.map((startup) => startup.promise));
    for (const startup of startups) {
      if (startup.server) {
        servers.add(startup.server);
      }
    }
    await Promise.all(Array.from(servers, (server) => this.killServer(server)));
    this.currentServer = null;
    this.retiredServers.clear();
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<void> {
    if (
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined)
    ) {
      return;
    }
    const result = await this.terminateProcess(server.process, {
      gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server did not report exit after SIGKILL",
      );
    }
    if (server.managedProcessId) {
      await this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
  }

  private async recordManagedServerProcess(options: {
    process: ChildProcess;
    command: string;
    args: string[];
    port: number;
  }): Promise<{ id: string } | null> {
    const pid = options.process.pid;
    if (!this.managedProcesses || typeof pid !== "number" || pid <= 0) {
      return null;
    }

    try {
      return await this.managedProcesses.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: { port: options.port },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pid, port: options.port },
        "Failed to record OpenCode helper process",
      );
      return null;
    }
  }

  private removeManagedProcessRecordWhenResolved(record: Promise<{ id: string } | null>): void {
    void record.then((resolved) => {
      if (resolved) {
        return this.removeManagedProcessId(resolved.id);
      }
      return undefined;
    });
  }

  private removeManagedServerRecord(server: OpenCodeServerGeneration): void {
    const record = server.managedProcessRecord;
    server.managedProcessRecord = undefined;
    if (server.managedProcessId) {
      void this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      return;
    }
    if (record) {
      this.removeManagedProcessRecordWhenResolved(record);
    }
  }

  private async removeManagedProcessId(id: string): Promise<void> {
    try {
      await this.managedProcesses?.remove(id);
    } catch (error) {
      this.logger.warn({ err: error, id }, "Failed to remove OpenCode helper process record");
    }
  }
}

async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (!found) {
    throw new Error(
      "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.",
    );
  }

  if (process.platform === "win32" && path.extname(found).toLowerCase() === ".cmd") {
    // Global npm: <prefix>/opencode.cmd → <prefix>/node_modules/opencode-ai/bin/opencode.exe
    const globalCandidate = path.join(
      path.dirname(found),
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await pathExists(globalCandidate)) return globalCandidate;

    // Local/pnpm: <project>/node_modules/.bin/opencode.cmd → <project>/node_modules/opencode-ai/bin/opencode.exe
    const localCandidate = path.join(
      path.dirname(found),
      "..",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await pathExists(localCandidate)) return localCandidate;

    console.warn(
      "[opencode-server] Found opencode.cmd but could not resolve the real opencode.exe. " +
        "The process may not be properly terminated on exit. Path: %s",
      found,
    );
  }

  return found;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}
