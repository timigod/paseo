import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    close: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn(),
    getLastServerInfoMessage: vi.fn(() => ({ serverId: "daemon-1" })),
  },
  connectToDaemon: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: mocks.connectToDaemon,
  getDaemonHost: () => "localhost:6767",
}));
vi.mock("../../utils/provider-model.js", () => ({
  resolveProviderAndModel: () => ({ provider: "codex", model: undefined }),
}));

import { prepareAgentRunIntent } from "./run.js";

describe("run auto-archive", () => {
  it("preserves auto-archive in an idempotent fleet run intent", async () => {
    mocks.connectToDaemon.mockResolvedValue(mocks.client);

    const prepared = await prepareAgentRunIntent("implement the task", {
      autoArchive: true,
      idempotencyKey: "fleet-task-1",
      newWorkspace: "local",
    });

    expect(prepared.intent.create.autoArchive).toBe(true);
    expect(prepared.intent.create.idempotencyKey).toBe("fleet-task-1");
    expect(mocks.client.createWorkspace).not.toHaveBeenCalled();
  });
});
