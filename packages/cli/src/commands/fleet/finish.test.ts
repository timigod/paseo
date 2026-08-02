import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToDaemon: vi.fn(),
  fetchAllAgents: vi.fn(),
  runFinishCommand: vi.fn(),
  loadFleetConfig: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({ connectToDaemon: mocks.connectToDaemon }));
vi.mock("../../utils/inventory.js", () => ({ fetchAllAgents: mocks.fetchAllAgents }));
vi.mock("../agent/finish.js", () => ({
  addFinishOptions: (command: unknown) => command,
  runFinishCommand: mocks.runFinishCommand,
}));
vi.mock("./topology.js", () => ({
  findFleetHost: (value: string, hosts: Array<{ id: string }>) =>
    hosts.find(({ id }) => id === value),
  findFleetHostForCwd: vi.fn(),
  findFleetHostForHostname: vi.fn(),
  loadFleetConfig: mocks.loadFleetConfig,
}));

import { runFleetFinishCommand } from "./index.js";

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
  it("proves ownership across every host before applying a host pin to the mutation", async () => {
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

    await runFleetFinishCommand(
      "agent-123",
      { host: "builder-a" },
      {} as Parameters<typeof runFleetFinishCommand>[2],
    );

    expect(mocks.connectToDaemon).toHaveBeenCalledTimes(2);
    expect(mocks.connectToDaemon).toHaveBeenCalledWith({ host: builderA.endpoint });
    expect(mocks.connectToDaemon).toHaveBeenCalledWith({ host: builderB.endpoint });
    expect(mocks.runFinishCommand).toHaveBeenCalledWith(
      "agent-123456",
      { host: builderA.endpoint },
      expect.anything(),
    );
  });
});
