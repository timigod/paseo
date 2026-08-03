import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it, vi } from "vitest";
import { LIVE_HISTORY_FETCH_TIMEOUT_MS } from "../../utils/timeline.js";
import { fetchAgentTimelineItems } from "./logs.js";

function createClient() {
  const fetchAgentTimeline = vi.fn(async () => ({ entries: [] }));
  return {
    client: { fetchAgentTimeline } as unknown as DaemonClient,
    fetchAgentTimeline,
  };
}

describe("fetchAgentTimelineItems", () => {
  it("uses the shared live-history deadline for logs", async () => {
    const { client, fetchAgentTimeline } = createClient();

    await fetchAgentTimelineItems(client, "agent-1");

    expect(fetchAgentTimeline).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ timeout: LIVE_HISTORY_FETCH_TIMEOUT_MS }),
    );
  });

  it("keeps caller-specific deadlines configurable", async () => {
    const { client, fetchAgentTimeline } = createClient();

    await fetchAgentTimelineItems(client, "agent-1", { timeoutMs: 4_000 });

    expect(fetchAgentTimeline).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ timeout: 4_000 }),
    );
  });
});
