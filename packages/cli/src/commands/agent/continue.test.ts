import { beforeEach, describe, expect, it, vi } from "vitest";
import { runContinueCommand } from "./continue.js";

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: vi.fn().mockReturnValue("localhost:6767"),
}));

vi.mock("./recover.js", () => ({ runRecoverCommand: vi.fn() }));

vi.mock("./send.js", () => ({
  addSendOptions: vi.fn((command) => command),
  runSendCommand: vi.fn(),
}));

function installClient(agent: Record<string, unknown>) {
  return {
    fetchAgent: vi.fn().mockResolvedValue({ agent }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runContinueCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recovers an archived task before sending its next instruction", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const { runRecoverCommand } = await import("./recover.js");
    const { runSendCommand } = await import("./send.js");
    const client = installClient({ id: "agent-1", archivedAt: "2026-07-25T00:00:00.000Z" });
    const result = { type: "single" as const, data: {}, schema: {} };
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);
    vi.mocked(runRecoverCommand).mockResolvedValue(undefined as never);
    vi.mocked(runSendCommand).mockResolvedValue(result as never);

    await expect(runContinueCommand("old-name", "next step", {}, {} as never)).resolves.toBe(
      result,
    );

    expect(runRecoverCommand).toHaveBeenCalledWith(
      "agent-1",
      { host: undefined },
      expect.anything(),
    );
    expect(runSendCommand).toHaveBeenCalledWith("agent-1", "next step", {}, expect.anything());
  });

  it("sends directly to a live task without restarting it", async () => {
    const { connectToDaemon } = await import("../../utils/client.js");
    const { runRecoverCommand } = await import("./recover.js");
    const { runSendCommand } = await import("./send.js");
    const client = installClient({ id: "agent-1", archivedAt: null });
    const result = { type: "single" as const, data: {}, schema: {} };
    vi.mocked(connectToDaemon).mockResolvedValue(client as never);
    vi.mocked(runSendCommand).mockResolvedValue(result as never);

    await runContinueCommand("agent-1", "next step", {}, {} as never);

    expect(runRecoverCommand).not.toHaveBeenCalled();
    expect(runSendCommand).toHaveBeenCalledWith("agent-1", "next step", {}, expect.anything());
  });
});
