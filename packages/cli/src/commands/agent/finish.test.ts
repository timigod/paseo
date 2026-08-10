import { ATOMIC_FINISH_CONTRACT } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { renderJson } from "../../output/index.js";
import { runFinishCommand } from "./finish.js";

const finishAgent = vi.fn(async () => ({
  requestId: "request-1",
  contract: ATOMIC_FINISH_CONTRACT,
  operationId: "operation-1",
  agentId: "agent-1",
  workspaceId: "workspace-1",
  archivedAt: "2026-08-10T12:00:00.000Z",
  workspaceReleased: true,
  removedDirectory: false,
}));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ finishAgent, close })),
  getDaemonHost: vi.fn(() => "ws://target-host:6767"),
}));

describe("runFinishCommand", () => {
  it("returns the exact atomic finish JSON receipt", async () => {
    const result = await runFinishCommand(
      "agent-1",
      {
        operationId: "operation-1",
        workspaceId: "workspace-1",
        host: "target-host:6767",
      },
      {} as never,
    );

    expect(finishAgent).toHaveBeenCalledWith({
      operationId: "operation-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });
    expect(
      JSON.parse(
        renderJson(result, {
          format: "json",
          quiet: false,
          noHeaders: false,
          noColor: true,
        }),
      ),
    ).toEqual({
      contract: ATOMIC_FINISH_CONTRACT,
      operationId: "operation-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      archivedAt: "2026-08-10T12:00:00.000Z",
      workspaceReleased: true,
      removedDirectory: false,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
