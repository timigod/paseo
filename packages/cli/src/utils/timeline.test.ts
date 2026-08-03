import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it, vi } from "vitest";
import { fetchProjectedTimelineItems, LIVE_HISTORY_FETCH_TIMEOUT_MS } from "./timeline.js";

function createClient() {
  const fetchAgentTimeline = vi.fn(async () => ({ entries: [] }));
  return {
    client: { fetchAgentTimeline } as unknown as DaemonClient,
    fetchAgentTimeline,
  };
}

describe("fetchProjectedTimelineItems", () => {
  it("uses the shared bounded live-history timeout by default", async () => {
    const { client, fetchAgentTimeline } = createClient();

    await fetchProjectedTimelineItems({ client, agentId: "agent-1" });

    expect(fetchAgentTimeline).toHaveBeenCalledWith("agent-1", {
      direction: "tail",
      limit: 0,
      projection: "projected",
      timeout: LIVE_HISTORY_FETCH_TIMEOUT_MS,
    });
    expect(LIVE_HISTORY_FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it("accepts a shorter caller-specific timeout", async () => {
    const { client, fetchAgentTimeline } = createClient();

    await fetchProjectedTimelineItems({ client, agentId: "agent-1", timeoutMs: 2_000 });

    expect(fetchAgentTimeline).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ timeout: 2_000 }),
    );
  });
});
