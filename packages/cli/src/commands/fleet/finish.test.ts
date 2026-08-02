import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToDaemon: vi.fn(),
  fetchAllAgents: vi.fn(),
  runFinishCommand: vi.fn(),
  runReloadCommand: vi.fn(),
  runSendCommand: vi.fn(),
  loadFleetConfig: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({ connectToDaemon: mocks.connectToDaemon }));
vi.mock("../../utils/inventory.js", () => ({ fetchAllAgents: mocks.fetchAllAgents }));
vi.mock("../agent/run.js", () => ({
  addRunOptions: (command: unknown) => command,
  prepareAgentRunIntent: vi.fn(),
  runAgentRunIntent: vi.fn(),
  runRunCommand: vi.fn(),
}));
vi.mock("../agent/finish.js", () => ({
  addFinishOptions: (command: unknown) => command,
  runFinishCommand: mocks.runFinishCommand,
}));
vi.mock("../agent/reload.js", () => ({
  addReloadOptions: (command: unknown) => command,
  runReloadCommand: mocks.runReloadCommand,
}));
vi.mock("../agent/send.js", () => ({
  addSendOptions: (command: unknown) => command,
  runSendCommand: mocks.runSendCommand,
}));
vi.mock("./topology.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topology.js")>()),
  findFleetHost: (value: string, hosts: Array<{ id: string }>) =>
    hosts.find(({ id }) => id === value),
  findFleetHostForCwd: vi.fn(),
  findFleetHostForHostname: vi.fn(),
  loadFleetConfig: mocks.loadFleetConfig,
}));

import { runFleetContinueCommand, runFleetFinishCommand, runFleetRecoverCommand } from "./index.js";

const builderA = {
  id: "builder-a",
  name: "Builder A",
  endpoint: "builder-a.internal:6767",
  codeRoot: "/srv/code",
  hostnamePrefixes: ["builder-a"],
  capacity: 8,
};
const builderB = {
  id: "builder-b",
  name: "Builder B",
  endpoint: "builder-b.internal:6767",
  codeRoot: "/opt/code",
  hostnamePrefixes: ["builder-b"],
  capacity: 8,
};

describe("fleet finish", () => {
  it("rejects a host pin that contradicts the globally proven owner", async () => {
    mocks.loadFleetConfig.mockReturnValue({
      hosts: [builderA, builderB],
      defaults: { provider: "codex" },
    });
    mocks.connectToDaemon.mockImplementation(async ({ host }: { host: string }) => ({
      host,
      close: vi.fn().mockResolvedValue(undefined),
    }));
    mocks.fetchAllAgents.mockImplementation(async (client: { host: string }) =>
      client.host === builderB.endpoint
        ? [{ id: "agent-123456", title: "Fleet task", archivedAt: null }]
        : [],
    );
    mocks.runFinishCommand.mockResolvedValue({
      type: "single",
      data: { agentId: "agent-123456" },
      schema: { idField: "agentId", columns: [] },
    });

    await expect(
      runFleetFinishCommand(
        "agent-123",
        { host: "builder-a" },
        {} as Parameters<typeof runFleetFinishCommand>[2],
      ),
    ).rejects.toMatchObject({ code: "FLEET_AGENT_ON_OTHER_HOST" });

    expect(mocks.connectToDaemon).toHaveBeenCalledTimes(2);
    expect(mocks.connectToDaemon).toHaveBeenCalledWith({ host: builderA.endpoint });
    expect(mocks.connectToDaemon).toHaveBeenCalledWith({ host: builderB.endpoint });
    expect(mocks.runFinishCommand).not.toHaveBeenCalled();
  });
});

describe("fleet recovery", () => {
  it("locates the owner before delegating recovery", async () => {
    mocks.loadFleetConfig.mockReturnValue({
      hosts: [builderA, builderB],
      defaults: { provider: "codex" },
    });
    mocks.connectToDaemon.mockImplementation(async ({ host }: { host: string }) => ({
      host,
      close: vi.fn().mockResolvedValue(undefined),
    }));
    mocks.fetchAllAgents.mockImplementation(async (client: { host: string }) =>
      client.host === builderB.endpoint ? [{ id: "agent-123456", archivedAt: "2026-01-01" }] : [],
    );
    mocks.runReloadCommand.mockResolvedValue({ type: "single", data: {}, schema: {} });

    await runFleetRecoverCommand(
      "agent-123",
      {},
      {} as Parameters<typeof runFleetRecoverCommand>[2],
    );

    expect(mocks.runReloadCommand).toHaveBeenCalledWith(
      "agent-123456",
      { host: builderB.endpoint },
      expect.anything(),
    );
  });
});

describe("fleet continue", () => {
  it("recovers an archived owner before sending the next prompt", async () => {
    mocks.loadFleetConfig.mockReturnValue({
      hosts: [builderA, builderB],
      defaults: { provider: "codex" },
    });
    mocks.connectToDaemon.mockImplementation(async ({ host }: { host: string }) => ({
      host,
      close: vi.fn().mockResolvedValue(undefined),
    }));
    mocks.fetchAllAgents.mockImplementation(async (client: { host: string }) =>
      client.host === builderB.endpoint ? [{ id: "agent-123456", archivedAt: "2026-01-01" }] : [],
    );
    mocks.runReloadCommand.mockResolvedValue({ type: "single", data: {}, schema: {} });
    mocks.runSendCommand.mockResolvedValue({ type: "single", data: {}, schema: {} });

    await runFleetContinueCommand(
      "agent-123",
      "continue the task",
      {},
      {} as Parameters<typeof runFleetContinueCommand>[3],
    );

    expect(mocks.runReloadCommand).toHaveBeenCalledWith(
      "agent-123456",
      { host: builderB.endpoint },
      expect.anything(),
    );
    expect(mocks.runSendCommand).toHaveBeenCalledWith(
      "agent-123456",
      "continue the task",
      { host: builderB.endpoint },
      expect.anything(),
    );
  });
});
