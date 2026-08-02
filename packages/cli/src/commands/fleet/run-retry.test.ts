import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetHost } from "./topology.js";

const mocks = vi.hoisted(() => ({
  collectFleetStatus: vi.fn(),
  getOrCreateCliClientId: vi.fn().mockResolvedValue("caller-1"),
  prepareAgentRunIntent: vi.fn(),
  runAgentRunIntent: vi.fn(),
  resolveFleetRunPrompt: vi.fn(),
  resolveFleetProviderModelOptions: vi.fn(),
  resolveFleetWorktreeBase: vi.fn(),
  ensureFleetTargetProject: vi.fn(),
}));

vi.mock("../../utils/client-id.js", () => ({
  getOrCreateCliClientId: mocks.getOrCreateCliClientId,
}));
vi.mock("../agent/run.js", () => ({
  addRunOptions: (command: unknown) => command,
  prepareAgentRunIntent: mocks.prepareAgentRunIntent,
  runAgentRunIntent: mocks.runAgentRunIntent,
  runRunCommand: vi.fn(),
}));
vi.mock("./status.js", () => ({
  collectFleetStatus: mocks.collectFleetStatus,
  summarizeFleetHostStatus: vi.fn(),
  buildFleetDoctorResult: vi.fn(),
}));
vi.mock("./run.js", () => ({
  resolveFleetRunPrompt: mocks.resolveFleetRunPrompt,
  resolveFleetProviderModelOptions: mocks.resolveFleetProviderModelOptions,
  resolveFleetWorktreeBase: mocks.resolveFleetWorktreeBase,
}));
vi.mock("./project-preparation.js", () => ({
  ensureFleetTargetProject: mocks.ensureFleetTargetProject,
}));

import { claimFleetAffinity } from "./affinity.js";
import { runFleetRunCommand } from "./index.js";

const directories: string[] = [];
const originalFleetConfig = process.env.PASEO_FLEET_CONFIG;

afterEach(async () => {
  vi.clearAllMocks();
  if (originalFleetConfig === undefined) {
    delete process.env.PASEO_FLEET_CONFIG;
  } else {
    process.env.PASEO_FLEET_CONFIG = originalFleetConfig;
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function fleetHost(overrides: Partial<FleetHost> = {}): FleetHost {
  return {
    id: "builder-a",
    name: "Builder A",
    endpoint: "builder-a.internal:6767",
    codeRoot: "/srv/code",
    hostnamePrefixes: ["builder-a"],
    capacity: 8,
    ...overrides,
  };
}

async function writeFleetConfig(
  filePath: string,
  hosts: readonly FleetHost[],
  model: string,
): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      hosts,
      defaults: { provider: "codex", model, thinking: "high" },
    }),
  );
}

async function createFleetConfig(hosts: readonly FleetHost[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-run-retry-"));
  directories.push(directory);
  const configPath = path.join(directory, "fleet.json");
  process.env.PASEO_FLEET_CONFIG = configPath;
  await writeFleetConfig(configPath, hosts, "gpt-original");
  return configPath;
}

function readyFleetStatuses(config: { hosts: unknown[] }) {
  return config.hosts.map((host) => ({
    host,
    reachable: true,
    providerReady: true,
    agentInventoryReady: true,
    workspaceInventoryReady: true,
    activeAgents: 0,
    workspaceIds: [],
  }));
}

function readyFleetStatusesExcept(config: { hosts: FleetHost[] }, unreachableHostId: string) {
  const statuses = readyFleetStatuses(config);
  for (const status of statuses) {
    if ((status.host as FleetHost).id === unreachableHostId) status.reachable = false;
  }
  return statuses;
}

function configureRunMocks() {
  mocks.collectFleetStatus.mockImplementation(readyFleetStatuses);
  mocks.resolveFleetRunPrompt.mockResolvedValue("original prompt");
  mocks.resolveFleetProviderModelOptions.mockReturnValue({
    provider: "codex",
    model: "gpt-original",
    effectiveProvider: "codex",
    effectiveModel: "gpt-original",
  });
  mocks.resolveFleetWorktreeBase.mockReturnValue("a".repeat(40));
  mocks.ensureFleetTargetProject.mockImplementation(async ({ sourceCwd }) => ({
    cwd: sourceCwd,
    prepared: "existing",
  }));
  const intent = {
    create: {
      type: "create_agent_request" as const,
      config: {
        provider: "codex" as const,
        cwd: "/srv/code/project",
        model: "gpt-original",
        thinkingOptionId: "high",
      },
      initialPrompt: "original prompt",
      idempotencyKey: "create-1",
      workspaceSource: {
        kind: "worktree" as const,
        cwd: "/srv/code/project",
        baseBranch: "a".repeat(40),
      },
      labels: {},
    },
    prompt: "original prompt",
    waitTimeoutMs: 0,
    background: true,
  };
  mocks.prepareAgentRunIntent.mockResolvedValue({ intent, daemonId: "daemon-a" });
  mocks.runAgentRunIntent.mockResolvedValue({
    type: "single",
    data: {
      agentId: "agent-1",
      status: "running",
      provider: "codex",
      cwd: "/srv/code/project",
      title: null,
    },
    schema: { idField: "agentId", columns: [] },
  });
  return intent;
}

const runOptions = {
  idempotencyKey: "create-1",
  background: true,
  cwd: "/srv/code/project",
  newWorkspace: "worktree" as const,
  host: "builder-a.internal:6767",
};

describe("fleet run retry affinity", () => {
  it("accepts the original endpoint selector after drift and preserves the resolved intent", async () => {
    const configPath = await createFleetConfig([fleetHost()]);
    const intent = configureRunMocks();

    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);
    await writeFleetConfig(
      configPath,
      [fleetHost({ endpoint: "builder-a.internal:7777" })],
      "gpt-new-default",
    );
    mocks.resolveFleetRunPrompt.mockResolvedValue("changed prompt");
    mocks.resolveFleetProviderModelOptions.mockReturnValue({
      provider: "codex",
      model: "gpt-new-default",
      effectiveProvider: "codex",
      effectiveModel: "gpt-new-default",
    });
    mocks.resolveFleetWorktreeBase.mockReturnValue("b".repeat(40));

    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);

    expect(mocks.resolveFleetRunPrompt).toHaveBeenCalledOnce();
    expect(mocks.resolveFleetProviderModelOptions).toHaveBeenCalledOnce();
    expect(mocks.resolveFleetWorktreeBase).toHaveBeenCalledOnce();
    expect(mocks.resolveFleetWorktreeBase).toHaveBeenCalledWith(
      expect.objectContaining({ newWorkspace: "worktree", host: "builder-a.internal:6767" }),
      runOptions.cwd,
      undefined,
      false,
    );
    expect(mocks.prepareAgentRunIntent).toHaveBeenCalledOnce();
    const { idempotencyKey: _idempotencyKey, ...persistedCreate } = intent.create;
    expect(mocks.runAgentRunIntent).toHaveBeenLastCalledWith({
      intent: {
        ...intent,
        create: persistedCreate,
      },
      host: "builder-a.internal:7777",
      expectedDaemonId: "daemon-a",
      idempotencyKey: "create-1",
    });
  });

  it("rejects a stored endpoint selector that is now another host's exact ID", async () => {
    const originalOwner = fleetHost({ endpoint: "builder-b" });
    const configPath = await createFleetConfig([originalOwner]);
    configureRunMocks();
    const options = { ...runOptions, host: "builder-b" };

    await runFleetRunCommand(undefined, options, {} as Parameters<typeof runFleetRunCommand>[2]);
    await writeFleetConfig(
      configPath,
      [
        fleetHost({ endpoint: "builder-a.internal:7777" }),
        fleetHost({
          id: "builder-b",
          name: "Builder B",
          endpoint: "builder-b.internal:6767",
          hostnamePrefixes: ["builder-b"],
        }),
      ],
      "gpt-original",
    );

    await expect(
      runFleetRunCommand(undefined, options, {} as Parameters<typeof runFleetRunCommand>[2]),
    ).rejects.toMatchObject({ code: "FLEET_KEY_HOST_CONFLICT" });
    expect(mocks.runAgentRunIntent).toHaveBeenCalledTimes(1);
  });

  it("routes a claimed affinity to its exact host ID when an earlier endpoint collides", async () => {
    const endpointShadow = fleetHost({
      id: "builder-shadow",
      name: "Builder Shadow",
      endpoint: "builder-a",
      hostnamePrefixes: ["builder-shadow"],
    });
    const owner = fleetHost({ id: "Builder-A" });
    await createFleetConfig([endpointShadow, owner]);
    const intent = configureRunMocks();
    mocks.collectFleetStatus.mockImplementation((config: { hosts: FleetHost[] }) =>
      readyFleetStatusesExcept(config, endpointShadow.id),
    );

    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);

    const { idempotencyKey: _idempotencyKey, ...persistedCreate } = intent.create;
    expect(mocks.runAgentRunIntent).toHaveBeenCalledWith({
      intent: { ...intent, create: persistedCreate },
      host: owner.endpoint,
      expectedDaemonId: "daemon-a",
      idempotencyKey: "create-1",
    });
  });

  it("fails closed when the owner is removed but another host endpoint matches its ID", async () => {
    const configPath = await createFleetConfig([fleetHost()]);
    configureRunMocks();
    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);
    await writeFleetConfig(
      configPath,
      [
        fleetHost({
          id: "builder-shadow",
          name: "Builder Shadow",
          endpoint: "builder-a",
          hostnamePrefixes: ["builder-shadow"],
        }),
      ],
      "gpt-original",
    );

    await expect(
      runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]),
    ).rejects.toMatchObject({ code: "FLEET_AFFINITY_HOST_MISSING" });
    expect(mocks.runAgentRunIntent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the owner is replaced during an existing retry", async () => {
    const configPath = await createFleetConfig([fleetHost()]);
    configureRunMocks();
    const options = { ...runOptions, host: undefined };
    await runFleetRunCommand(undefined, options, {} as Parameters<typeof runFleetRunCommand>[2]);
    mocks.getOrCreateCliClientId.mockImplementationOnce(async () => {
      await writeFleetConfig(
        configPath,
        [
          fleetHost({
            id: "builder-replacement",
            name: "Builder Replacement",
            hostnamePrefixes: ["builder-replacement"],
          }),
        ],
        "gpt-original",
      );
      return "caller-1";
    });

    await expect(
      runFleetRunCommand(undefined, options, {} as Parameters<typeof runFleetRunCommand>[2]),
    ).rejects.toMatchObject({ code: "FLEET_AFFINITY_HOST_MISSING" });
    expect(mocks.runAgentRunIntent).toHaveBeenCalledTimes(1);
  });

  it("accepts a mixed-case concurrent claim owner and reloads its current endpoint", async () => {
    const configPath = await createFleetConfig([fleetHost()]);
    const intent = configureRunMocks();
    mocks.prepareAgentRunIntent.mockImplementationOnce(async () => {
      await writeFleetConfig(
        configPath,
        [fleetHost({ endpoint: "builder-a.internal:7777" })],
        "gpt-original",
      );
      await claimFleetAffinity({
        callerId: "caller-1",
        idempotencyKey: "create-1",
        affinity: {
          host: fleetHost({ id: "Builder-A" }),
          daemonId: "daemon-winner",
          intent,
        },
      });
      return { intent, daemonId: "daemon-candidate" };
    });

    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);

    const { idempotencyKey: _idempotencyKey, ...persistedCreate } = intent.create;
    expect(mocks.runAgentRunIntent).toHaveBeenCalledWith({
      intent: { ...intent, create: persistedCreate },
      host: "builder-a.internal:7777",
      expectedDaemonId: "daemon-winner",
      idempotencyKey: "create-1",
    });
  });
});
