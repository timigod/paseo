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
  UNMANAGED_AGENT_RUNTIME_RESERVATION,
  withTemporaryRuntimeCapacity,
} from "../../agent-runtime-capacity.js";
import type {
  AgentRuntimeCapacityController,
  AgentRuntimeCapacityReservation,
} from "../../agent-sdk-types.js";
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

export interface OpenCodeServerManagerLike {
  acquireCurrent(): Promise<OpenCodeServerAcquisition>;
  acquireNew(): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  configureRuntimeCapacityController(controller: AgentRuntimeCapacityController): void;
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
  runtimeCapacityController: AgentRuntimeCapacityController | null;
  runtimeCapacityReservation: AgentRuntimeCapacityReservation;
  runtimeCapacityTracked: boolean;
  runtimeCapacityReleased: boolean;
  terminationPromise: Promise<boolean> | null;
  cancelStart: (() => void) | null;
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
  private startingServers = new Set<OpenCodeServerGeneration>();
  private activeStartOperations = new Set<Promise<OpenCodeServerAcquisition>>();
  private serverStartPromises = new Set<Promise<OpenCodeServerGeneration>>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownEpoch = 0;
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
  private runtimeCapacityController: AgentRuntimeCapacityController | null = null;

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

  configureRuntimeCapacityController(controller: AgentRuntimeCapacityController): void {
    this.runtimeCapacityController = controller;
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

  acquireCurrent(): Promise<OpenCodeServerAcquisition> {
    return this.runStartOperation(async (shutdownEpoch) => {
      const server = await this.getCurrentServer(shutdownEpoch);
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(server);
      }
      return this.acquireServer(server);
    });
  }

  acquireNew(): Promise<OpenCodeServerAcquisition> {
    return this.runStartOperation(async (shutdownEpoch) => {
      const server = await this.getNewServer(shutdownEpoch);
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(server);
      }
      return this.acquireServer(server);
    });
  }

  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    return this.runStartOperation((shutdownEpoch) =>
      this.acquireDedicatedDuringShutdownEpoch(env, shutdownEpoch),
    );
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    if (this.shutdownPromise) {
      return null;
    }
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  private runStartOperation(
    start: (shutdownEpoch: number) => Promise<OpenCodeServerAcquisition>,
  ): Promise<OpenCodeServerAcquisition> {
    let shutdownEpoch: number;
    try {
      shutdownEpoch = this.beginStartOperation();
    } catch (error) {
      return Promise.reject(error);
    }

    const operation = start(shutdownEpoch);
    this.activeStartOperations.add(operation);
    void operation.then(
      () => this.activeStartOperations.delete(operation),
      () => this.activeStartOperations.delete(operation),
    );
    return operation;
  }

  private beginStartOperation(): number {
    if (this.shutdownPromise) {
      throw this.createShutdownStartError();
    }
    return this.shutdownEpoch;
  }

  private async acquireDedicatedDuringShutdownEpoch(
    env: Record<string, string>,
    shutdownEpoch: number,
  ): Promise<OpenCodeServerAcquisition> {
    const server = await this.startServer(shutdownEpoch, env);
    if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
      await this.failCrossedStart(server);
    }
    this.startingServers.delete(server);
    server.retired = true;
    this.retiredServers.add(server);
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(server);
      }
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
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

    this.retiredServers.add(server);
    if (await this.killServer(server)) {
      this.retiredServers.delete(server);
    }
  }

  private async getNewServer(shutdownEpoch: number): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      const pending = await this.newServerPromise;
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(pending);
      }
      return pending;
    }

    this.newServerPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer();
        this.assertStartCanContinue(shutdownEpoch);
        const server = await this.startServer(shutdownEpoch);
        if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
          await this.failCrossedStart(server);
        }
        this.startingServers.delete(server);
        if (!server.retired) {
          this.currentServer = server;
        }
        await server.ready;
        if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
          await this.failCrossedStart(server);
        }
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(shutdownEpoch: number): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      const pending = await this.newServerPromise;
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(pending);
      }
      return pending;
    }

    if (this.startPromise) {
      const server = await this.startPromise;
      await server.ready;
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(server);
      }
      return server;
    }

    const current = this.currentServer;
    if (current && !current.process.killed) {
      await current.ready;
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(current);
      }
      return current;
    }

    this.startPromise = this.startServer(shutdownEpoch).then(async (server) => {
      if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
        await this.failCrossedStart(server);
      }
      this.startingServers.delete(server);
      if (!server.retired) {
        this.currentServer = server;
      }
      return server;
    });
    const currentStart = this.startPromise;
    const result = await currentStart.finally(() => {
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
    await result.ready;
    if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
      await this.failCrossedStart(result);
    }
    return result;
  }

  private async rotateCurrentServer(): Promise<void> {
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      await this.cleanupRetiredServers();
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      await this.cleanupRetiredServers();
    }
  }

  private startServer(
    shutdownEpoch: number,
    launchEnv?: Record<string, string>,
  ): Promise<OpenCodeServerGeneration> {
    const start = this.startServerProcess(shutdownEpoch, launchEnv);
    this.serverStartPromises.add(start);
    void start.then(
      () => this.serverStartPromises.delete(start),
      () => this.serverStartPromises.delete(start),
    );
    return start;
  }

  private async startServerProcess(
    shutdownEpoch: number,
    launchEnv?: Record<string, string>,
  ): Promise<OpenCodeServerGeneration> {
    this.assertStartCanContinue(shutdownEpoch);
    const port = await this.portAllocator();
    this.assertStartCanContinue(shutdownEpoch);
    const url = `http://127.0.0.1:${port}`;
    const runtimeCapacityController = this.runtimeCapacityController;
    const launchPrefix = await withTemporaryRuntimeCapacity(runtimeCapacityController, () =>
      this.resolveCommandPrefix(),
    );
    this.assertStartCanContinue(shutdownEpoch);
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    const runtimeCapacityReservation =
      runtimeCapacityController?.reserve() ?? UNMANAGED_AGENT_RUNTIME_RESERVATION;
    try {
      this.assertStartCanContinue(shutdownEpoch);
    } catch (error) {
      runtimeCapacityReservation.release();
      throw error;
    }
    let serverProcess: ChildProcess;
    try {
      serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
        cwd: serverCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        ...createProviderEnvSpec({
          baseEnv: this.baseEnv,
          runtimeSettings: this.runtimeSettings,
          overlays: [launchEnv],
        }),
      });
    } catch (error) {
      runtimeCapacityReservation.release();
      throw error;
    }
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
      runtimeCapacityController,
      runtimeCapacityReservation,
      runtimeCapacityTracked: false,
      runtimeCapacityReleased: false,
      terminationPromise: null,
      cancelStart: null,
    };
    this.startingServers.add(server);
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
      const failStartup = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        server.cancelStart = null;
        clearTimeout(timeout);
        reject(error);
      };
      server.cancelStart = () => {
        failStartup(this.createShutdownStartError());
      };
      timeout = setTimeout(() => {
        if (!started) {
          failStartup(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.on("exit", (code) => {
        this.releaseServerRuntimeCapacity(server);
        this.removeManagedServerRecord(server);
        if (!started) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)),
          );
        }
        this.startingServers.delete(server);
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess) {
            this.retiredServers.delete(retired);
          }
        }
      });

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !settled) {
          started = true;
          settled = true;
          server.cancelStart = null;
          clearTimeout(timeout);
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

      try {
        runtimeCapacityReservation.track(serverProcess);
        server.runtimeCapacityTracked = true;
      } catch (error) {
        const trackError = error instanceof Error ? error : new Error(String(error));
        failStartup(trackError);
      }
    });

    server.ready = ready.catch(async (error) => {
      this.startingServers.delete(server);
      server.retired = true;
      this.retiredServers.add(server);
      const terminated = await this.killServer(server);
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      if (terminated) {
        this.retiredServers.delete(server);
      } else {
        server.retired = true;
        this.retiredServers.add(server);
      }
      throw error;
    });

    if (this.hasCrossedShutdownBarrier(shutdownEpoch)) {
      await this.failCrossedStart(server);
    }
    return server;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownEpoch += 1;
    const shutdown = this.performShutdown().finally(() => {
      if (this.shutdownPromise === shutdown) {
        this.shutdownPromise = null;
      }
    });
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  private async performShutdown(): Promise<void> {
    const terminationErrors: unknown[] = [];
    await Promise.allSettled(Array.from(this.serverStartPromises));
    terminationErrors.push(...(await this.terminateOwnedServers()));
    await Promise.allSettled(Array.from(this.activeStartOperations));
    await Promise.allSettled(Array.from(this.serverStartPromises));
    terminationErrors.push(...(await this.terminateOwnedServers()));
    if (terminationErrors.length > 0) {
      throw terminationErrors[0];
    }
  }

  private async terminateOwnedServers(): Promise<unknown[]> {
    const servers = new Set([
      ...this.startingServers,
      ...(this.currentServer ? [this.currentServer] : []),
      ...this.retiredServers,
    ]);
    this.currentServer = null;
    for (const server of servers) {
      this.startingServers.delete(server);
      server.retired = true;
      this.retiredServers.add(server);
      server.cancelStart?.();
    }
    const results = await Promise.allSettled(
      Array.from(servers, async (server) => ({
        server,
        terminated: await this.killServer(server),
      })),
    );
    const terminationErrors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        terminationErrors.push(result.reason);
        continue;
      }
      if (result.value.terminated) {
        this.retiredServers.delete(result.value.server);
      }
    }
    return terminationErrors;
  }

  private hasCrossedShutdownBarrier(shutdownEpoch: number): boolean {
    return shutdownEpoch !== this.shutdownEpoch;
  }

  private assertStartCanContinue(shutdownEpoch: number): void {
    if (this.shutdownPromise || this.hasCrossedShutdownBarrier(shutdownEpoch)) {
      throw this.createShutdownStartError();
    }
  }

  private createShutdownStartError(): Error {
    return new Error("OpenCode server start canceled by shutdown");
  }

  private async failCrossedStart(server: OpenCodeServerGeneration): Promise<never> {
    void server.ready.catch(() => undefined);
    this.startingServers.delete(server);
    if (this.currentServer === server) {
      this.currentServer = null;
    }
    server.retired = true;
    this.retiredServers.add(server);
    server.cancelStart?.();
    if (await this.killServer(server)) {
      this.retiredServers.delete(server);
    }
    throw this.createShutdownStartError();
  }

  private async cleanupRetiredServers(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        cleanup.push(
          this.killServer(server).then((terminated) => {
            if (terminated) {
              this.retiredServers.delete(server);
            }
            return undefined;
          }),
        );
      }
    }
    await Promise.all(cleanup);
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<boolean> {
    if (
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined)
    ) {
      this.releaseServerRuntimeCapacity(server);
      this.removeManagedServerRecord(server);
      return true;
    }
    if (server.terminationPromise) {
      return server.terminationPromise;
    }
    const terminationPromise = this.terminateServer(server).finally(() => {
      if (server.terminationPromise === terminationPromise) {
        server.terminationPromise = null;
      }
    });
    server.terminationPromise = terminationPromise;
    return terminationPromise;
  }

  private async terminateServer(server: OpenCodeServerGeneration): Promise<boolean> {
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
      return false;
    }

    this.releaseServerRuntimeCapacity(server);
    if (server.managedProcessId) {
      await this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
    return true;
  }

  private releaseServerRuntimeCapacity(server: OpenCodeServerGeneration): void {
    if (server.runtimeCapacityReleased) {
      return;
    }
    server.runtimeCapacityReleased = true;
    if (server.runtimeCapacityTracked) {
      server.runtimeCapacityController?.release(server.process);
      return;
    }
    server.runtimeCapacityReservation.release();
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
