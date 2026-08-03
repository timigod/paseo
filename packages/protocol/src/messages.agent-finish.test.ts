import { describe, expect, test } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("agent.finish RPC schemas", () => {
  test("accepts a finish request with idempotency key, force, and keepWorktree", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.finish.request",
      agentId: "agent-1",
      idempotencyKey: "finish-agent-1",
      force: true,
      keepWorktree: true,
      requestId: "req-1",
    });
    expect(parsed).toEqual(
      expect.objectContaining({
        type: "agent.finish.request",
        agentId: "agent-1",
        idempotencyKey: "finish-agent-1",
        force: true,
        keepWorktree: true,
      }),
    );
  });

  test("rejects a finish request without an idempotency key", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "agent.finish.request",
      agentId: "agent-1",
      requestId: "req-1",
    });
    expect(result.success).toBe(false);
  });

  test("round-trips success and refusal responses", () => {
    const success = SessionOutboundMessageSchema.parse({
      type: "agent.finish.response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        ok: true,
        error: null,
        errorCode: null,
        archivedAt: "2026-08-03T00:00:00.000Z",
        worktree: "released",
      },
    });
    expect(success).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ ok: true, worktree: "released" }),
      }),
    );

    const refusal = SessionOutboundMessageSchema.parse({
      type: "agent.finish.response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        ok: false,
        error: "Worktree has uncommitted changes",
        errorCode: "WORKTREE_DIRTY",
        archivedAt: null,
        worktree: null,
      },
    });
    expect(refusal).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ ok: false, errorCode: "WORKTREE_DIRTY" }),
      }),
    );
  });

  test("a minimal response without optional outcome fields still parses", () => {
    // Protocol contract: optional fields may be absent on either side.
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.finish.response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        ok: false,
        error: "failed",
      },
    });
    expect(parsed.type).toBe("agent.finish.response");
  });

  test("server_info advertises agentFinish and old daemons without it still parse", () => {
    const withFeature = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "daemon-1",
      features: { agentFinish: true },
    });
    expect(withFeature.features?.agentFinish).toBe(true);

    const oldDaemon = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "daemon-1",
      features: {},
    });
    expect(oldDaemon.features?.agentFinish).toBeUndefined();
  });
});
