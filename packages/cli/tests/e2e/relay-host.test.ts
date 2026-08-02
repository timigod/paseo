import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { generateLocalPairingOffer } from "@getpaseo/server";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import {
  createTestPaseoDaemon,
  type TestPaseoDaemon,
} from "../../../server/src/server/test-utils/paseo-daemon.ts";
import { getAvailablePort } from "../helpers/network.ts";
import { createE2ETestContext } from "../helpers/test-daemon.ts";

const nodeMajor = Number((process.versions.node ?? "0").split(".")[0] ?? "0");
const shouldRunRelayE2e = process.env.FORCE_RELAY_E2E === "1" || nodeMajor < 25;
const wranglerCliPath = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(__dirname, "../../../relay");
const STARTUP_HOOK_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitRelayLines(chunk: Buffer, prefix: "stdout" | "stderr"): void {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    // eslint-disable-next-line no-console
    if (prefix === "stderr") console.error(`[relay] ${line}`);
    // eslint-disable-next-line no-console
    else console.log(`[relay] ${line}`);
  }
}

function forwardRelayStdout(data: Buffer): void {
  emitRelayLines(data, "stdout");
}

function forwardRelayStderr(data: Buffer): void {
  emitRelayLines(data, "stderr");
}

function spawnRelayDevServer(port: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      wranglerCliPath,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--live-reload=false",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: relayDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );
}

function assertRelayStillRunning(relayProcess: ChildProcess): void {
  if (relayProcess.exitCode !== null) {
    throw new Error(
      `relay process exited before startup completed (code: ${relayProcess.exitCode})`,
    );
  }
}

function tryConnect(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function waitForServer(
  port: number,
  relayProcess: ChildProcess,
  timeout = 30000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assertRelayStillRunning(relayProcess);
    try {
      await tryConnect(port);
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
}

async function waitForProcessExit(relayProcess: ChildProcess, deadline: number): Promise<void> {
  while (relayProcess.exitCode === null && Date.now() < deadline) {
    await sleep(50);
  }
}

async function stopRelayProcess(relayProcess: ChildProcess): Promise<void> {
  if (relayProcess.exitCode !== null) return;
  relayProcess.kill("SIGTERM");
  await waitForProcessExit(relayProcess, Date.now() + SHUTDOWN_TIMEOUT_MS);
  if (relayProcess.exitCode !== null) return;
  relayProcess.kill("SIGKILL");
  await waitForProcessExit(relayProcess, Date.now() + 2000);
}

async function probeRelayConnection(offerUrl: string): Promise<boolean> {
  const offer = parseConnectionOfferFromUrl(offerUrl);
  if (!offer) return false;
  const url = buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint,
    serverId: offer.serverId,
    role: "client",
  });
  const client = new DaemonClient({
    url,
    clientId: `relay-probe-${Date.now()}`,
    clientType: "cli",
    connectTimeoutMs: 4000,
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
    webSocketFactory: (target: string, opts?: { headers?: Record<string, string> }) =>
      new WebSocket(target, { headers: opts?.headers }) as unknown as ReturnType<
        NonNullable<ConstructorParameters<typeof DaemonClient>[0]["webSocketFactory"]>
      >,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

async function waitForDaemonRelayRegistered(offerUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeRelayConnection(offerUrl)) return;
    await sleep(500);
  }
  throw new Error("Daemon failed to register with the relay within timeout");
}

(shouldRunRelayE2e ? describe : describe.skip)("CLI --host offer URL via relay", () => {
  let relayPort: number;
  let relayProcess: ChildProcess | null = null;
  let ctx: Awaited<ReturnType<typeof createE2ETestContext>> | null = null;
  let authorityDaemon: TestPaseoDaemon | null = null;
  let offerUrl: string;
  let authorityOfferUrl: string;

  beforeAll(async () => {
    relayPort = await getAvailablePort();
    relayProcess = spawnRelayDevServer(relayPort);
    relayProcess.stdout?.on("data", forwardRelayStdout);
    relayProcess.stderr?.on("data", forwardRelayStderr);

    try {
      await waitForServer(relayPort, relayProcess, 60_000);
    } catch (error) {
      await stopRelayProcess(relayProcess);
      relayProcess = null;
      throw error;
    }

    const relayEndpoint = `127.0.0.1:${relayPort}`;
    ctx = await createE2ETestContext({
      timeout: 60_000,
      env: {
        PASEO_RELAY_ENABLED: "true",
        PASEO_RELAY_ENDPOINT: relayEndpoint,
        PASEO_RELAY_PUBLIC_ENDPOINT: relayEndpoint,
      },
    });

    const offer = await generateLocalPairingOffer({
      paseoHome: ctx.paseoHome,
      relayEnabled: true,
      relayEndpoint,
      relayPublicEndpoint: relayEndpoint,
      includeQr: false,
    });
    if (!offer.url) throw new Error("generateLocalPairingOffer returned no URL");
    offerUrl = offer.url;

    await waitForDaemonRelayRegistered(offerUrl, 30_000);

    authorityDaemon = await createTestPaseoDaemon({
      listen: "127.0.0.1",
      relayEnabled: true,
      relayEndpoint,
      relayUseTls: false,
      relayPublicUseTls: false,
    });
    const authorityOffer = await generateLocalPairingOffer({
      paseoHome: authorityDaemon.paseoHome,
      relayEnabled: true,
      relayEndpoint,
      relayPublicEndpoint: relayEndpoint,
      includeQr: false,
    });
    if (!authorityOffer.url) throw new Error("generateLocalPairingOffer returned no URL");
    authorityOfferUrl = authorityOffer.url;
    await waitForDaemonRelayRegistered(authorityOfferUrl, 30_000);
  }, STARTUP_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (authorityDaemon) {
      await authorityDaemon.close();
      authorityDaemon = null;
    }
    if (ctx) {
      await ctx.stop();
      ctx = null;
    }
    if (relayProcess) {
      await stopRelayProcess(relayProcess);
      relayProcess = null;
    }
  }, SHUTDOWN_TIMEOUT_MS);

  it("runs `paseo --host <offer-url> ls` over the relay and matches direct ls output", async () => {
    if (!ctx) throw new Error("test context not initialized");

    const direct = await ctx.paseo(["ls", "--json"]);
    expect(direct.exitCode, `direct ls failed: ${direct.stderr}`).toBe(0);
    const directAgents = JSON.parse(direct.stdout.trim() || "[]");
    expect(Array.isArray(directAgents)).toBe(true);

    const relay = await ctx.paseo(["ls", "--json", "--host", offerUrl], {
      timeout: 30_000,
      env: { PASEO_HOST: offerUrl },
    });
    expect(relay.exitCode, `relay ls failed: ${relay.stderr}\nstdout: ${relay.stdout}`).toBe(0);
    const relayAgents = JSON.parse(relay.stdout.trim() || "[]");
    expect(Array.isArray(relayAgents)).toBe(true);
    expect(relayAgents.length).toBe(directAgents.length);
  }, 60_000);

  it("refuses every managed identity over an offer while preserving trusted offer access", async () => {
    if (!ctx || !authorityDaemon) throw new Error("test context not initialized");

    const createAgent = () =>
      authorityDaemon!.daemon.agentManager.createAgent(
        {
          provider: "codex",
          model: "gpt-5.4-mini",
          modeId: "full-access",
          cwd: ctx!.workDir,
        },
        undefined,
        { workspaceId: undefined },
      );

    const caller = await createAgent();
    const callerIdentity = authorityDaemon.daemon.agentManager.getAgentCallerIdentity(caller.id);
    const validAgentToken = authorityDaemon.daemon.agentManager.getAgentIngressAuthToken(caller.id);
    if (!callerIdentity || !validAgentToken) {
      throw new Error("expected current managed caller credentials");
    }

    const managedVariants: Array<{
      name: string;
      identity: NodeJS.ProcessEnv;
    }> = [
      {
        name: "omitted",
        identity: {
          PASEO_AGENT_ID: "",
          PASEO_AGENT_INCARNATION: "",
          PASEO_AGENT_AUTH_TOKEN: "",
        },
      },
      {
        name: "invalid",
        identity: {
          PASEO_AGENT_ID: callerIdentity.agentId,
          PASEO_AGENT_INCARNATION: callerIdentity.incarnation,
          PASEO_AGENT_AUTH_TOKEN: "invalid-agent-token",
        },
      },
      {
        name: "valid",
        identity: {
          PASEO_AGENT_ID: callerIdentity.agentId,
          PASEO_AGENT_INCARNATION: callerIdentity.incarnation,
          PASEO_AGENT_AUTH_TOKEN: validAgentToken,
        },
      },
    ];

    for (const variant of managedVariants) {
      const target = await createAgent();
      const result = await ctx.paseo(
        ["agent", "delete", target.id, "--json", "--host", authorityOfferUrl],
        {
          timeout: 30_000,
          env: {
            PASEO_HOME: authorityDaemon.paseoHome,
            PASEO_HOST: authorityOfferUrl,
            PASEO_MANAGED_AGENT_CONTEXT: "1",
            ...variant.identity,
          },
        },
      );
      expect(result.exitCode, `${variant.name}: ${result.stderr}\n${result.stdout}`).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        "Managed agent contexts cannot connect via pairing offers",
      );
      expect(authorityDaemon.daemon.agentManager.getAgent(target.id)?.id).toBe(target.id);
    }

    const trustedTarget = await createAgent();
    const trusted = await ctx.paseo(
      ["agent", "delete", trustedTarget.id, "--json", "--host", authorityOfferUrl],
      {
        timeout: 30_000,
        env: {
          PASEO_HOME: authorityDaemon.paseoHome,
          PASEO_HOST: authorityOfferUrl,
          PASEO_MANAGED_AGENT_CONTEXT: "",
          PASEO_AGENT_ID: "",
          PASEO_AGENT_INCARNATION: "",
          PASEO_AGENT_AUTH_TOKEN: "",
        },
      },
    );
    expect(trusted.exitCode, `${trusted.stderr}\n${trusted.stdout}`).toBe(0);
    expect(authorityDaemon.daemon.agentManager.getAgent(trustedTarget.id)).toBeNull();
  }, 60_000);
});
