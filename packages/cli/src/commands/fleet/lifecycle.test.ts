import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import {
  continueFleetAgent,
  findFleetAgentMatches,
  selectFleetAgentLocation,
} from "./lifecycle.js";
import { FLEET_HOSTS } from "./topology.js";

const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;
const imac = FLEET_HOSTS.find((host) => host.id === "imac")!;

describe("fleet lifecycle lookup", () => {
  it("keeps recovery and finish on the host that owns the persisted agent", () => {
    expect(
      selectFleetAgentLocation(
        "agent-1",
        [{ host: imac, agentId: "agent-123456", archived: false }],
        [],
      ),
    ).toEqual({ host: imac, agentId: "agent-123456", archived: false });
  });

  it("does not guess when a short reference is ambiguous across hosts", () => {
    expect(() =>
      selectFleetAgentLocation(
        "agent",
        [
          { host: macbook, agentId: "agent-111", archived: false },
          { host: imac, agentId: "agent-222", archived: false },
        ],
        [],
      ),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_AMBIGUOUS" }));
  });

  it("does not claim an agent is absent when fleet lookup is incomplete", () => {
    expect(() =>
      selectFleetAgentLocation("agent-1", [], [{ host: imac, error: "connection reset" }]),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_LOOKUP_INCOMPLETE" }));
  });

  it("does not select a matching owner when another fleet host lookup failed", () => {
    expect(() =>
      selectFleetAgentLocation(
        "shared-task",
        [{ host: macbook, agentId: "agent-111", archived: false }],
        [{ host: imac, error: "connection reset" }],
      ),
    ).toThrow(expect.objectContaining({ code: "FLEET_AGENT_LOOKUP_INCOMPLETE" }));
  });

  it("returns every prefix or name match so ambiguity is never guessed", () => {
    const agents = [
      { id: "agent-111", title: "Shared task" },
      { id: "agent-222", title: "Shared task" },
    ] as AgentSnapshotPayload[];

    expect(findFleetAgentMatches("agent", macbook, agents)).toEqual([
      { host: macbook, agentId: "agent-111", archived: false },
      { host: macbook, agentId: "agent-222", archived: false },
    ]);
    expect(findFleetAgentMatches("Shared task", macbook, agents)).toHaveLength(2);
    expect(findFleetAgentMatches("Shared", macbook, agents)).toEqual([]);
  });

  it("prefers an exact durable id over other local prefix matches", () => {
    const agents = [{ id: "agent" }, { id: "agent-extended" }] as AgentSnapshotPayload[];

    expect(findFleetAgentMatches("agent", imac, agents)).toEqual([
      { host: imac, agentId: "agent", archived: false },
    ]);
  });

  it("preserves archived state for the existing recovery path", () => {
    const agents = [
      { id: "agent-1", archivedAt: "2026-07-30T00:00:00.000Z" },
    ] as AgentSnapshotPayload[];

    expect(findFleetAgentMatches("agent-1", imac, agents)).toEqual([
      { host: imac, agentId: "agent-1", archived: true },
    ]);
  });
});

describe("fleet continuation", () => {
  it("restores an archived task before sending and identifies its owner", async () => {
    const recover = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue({
      type: "single",
      data: { agentId: "agent-1", status: "sent", message: "Message sent" },
      schema: { idField: "agentId", columns: [] },
    });

    const result = await continueFleetAgent(
      { host: imac, agentId: "agent-1", archived: true },
      "continue the task",
      { wait: false },
      new Command(),
      { recover, send },
    );

    expect(recover).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(recover.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(result.data).toEqual({
      agentId: "agent-1",
      status: "sent",
      message: "Message sent",
      fleetHost: "imac",
      fleetEndpoint: imac.endpoint,
      restored: true,
    });
  });

  it("sends directly when the durable task is not archived", async () => {
    const recover = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue({
      type: "single",
      data: { agentId: "agent-1", status: "completed", message: "Agent completed" },
      schema: { idField: "agentId", columns: [] },
    });

    const result = await continueFleetAgent(
      { host: macbook, agentId: "agent-1", archived: false },
      "continue the task",
      {},
      new Command(),
      { recover, send },
    );

    expect(recover).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "agent-1",
      "continue the task",
      expect.objectContaining({ host: macbook.endpoint }),
      expect.any(Command),
    );
    expect(result.data.restored).toBe(false);
  });

  it("does not restore archived work when the prompt is missing", async () => {
    const recover = vi.fn().mockResolvedValue({});
    const send = vi.fn();

    await expect(
      continueFleetAgent(
        { host: imac, agentId: "agent-1", archived: true },
        undefined,
        {},
        new Command(),
        { recover, send },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "MISSING_PROMPT" }));
    expect(recover).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not restore archived work when prompt sources conflict", async () => {
    const recover = vi.fn().mockResolvedValue({});
    const send = vi.fn();

    await expect(
      continueFleetAgent(
        { host: imac, agentId: "agent-1", archived: true },
        "positional prompt",
        { prompt: "option prompt" },
        new Command(),
        { recover, send },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "CONFLICTING_PROMPT_INPUT" }));
    expect(recover).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
