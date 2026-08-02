import { beforeEach, describe, expect, it, vi } from "vitest";

import { runStopCommand } from "./stop.js";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  archivedAt: null,
  cwd: "/tmp/project",
};
const cancelAgentWithOutcome = vi.fn();
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgents: vi.fn(async () => ({ entries: [{ agent }] })),
    fetchAgent: vi.fn(async () => ({ agent })),
    cancelAgentWithOutcome,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("runStopCommand", () => {
  beforeEach(() => {
    cancelAgentWithOutcome.mockReset();
    close.mockClear();
  });

  it.each([
    ["cancelled", 1],
    ["unknown", 1],
    ["not_running", 0],
    ["not_found", 0],
    ["archived", 0],
    ["not_resumable", 0],
  ] as const)("counts %s cancellation outcomes correctly", async (outcome, stoppedCount) => {
    cancelAgentWithOutcome.mockResolvedValueOnce(outcome);

    const result = await runStopCommand(agent.id, {}, {} as never);

    expect(cancelAgentWithOutcome).toHaveBeenCalledWith(agent.id);
    expect(result.data).toEqual({
      stoppedCount,
      agentIds: stoppedCount === 1 ? [agent.id] : [],
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
