import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";

import { runArchiveCommandWithDeps } from "./archive.js";

function createFakeDaemonClient(archiveWorkspace: DaemonClient["archiveWorkspace"]): DaemonClient {
  return {
    archiveWorkspace,
    close: async () => {},
  } as unknown as DaemonClient;
}

describe("workspace archive command", () => {
  it("keeps external coordinator calls unscoped", async () => {
    const calls: Parameters<DaemonClient["archiveWorkspace"]>[] = [];
    const client = createFakeDaemonClient(async (...args) => {
      calls.push(args);
      return {
        requestId: "req-1",
        workspaceId: "workspace-1",
        archivedAt: "2026-08-01T00:00:00.000Z",
        error: null,
      };
    });

    await runArchiveCommandWithDeps("workspace-1", {}, { connectToDaemon: async () => client }, {});

    expect(calls[0]?.[2]).toBeUndefined();
  });

  it("sends daemon-issued caller identity from a provider environment", async () => {
    const calls: Parameters<DaemonClient["archiveWorkspace"]>[] = [];
    const client = createFakeDaemonClient(async (...args) => {
      calls.push(args);
      return {
        requestId: "req-1",
        workspaceId: "workspace-1",
        archivedAt: "2026-08-01T00:00:00.000Z",
        error: null,
      };
    });

    await runArchiveCommandWithDeps(
      "workspace-1",
      {},
      { connectToDaemon: async () => client },
      {
        PASEO_AGENT_ID: " agent-1 ",
        PASEO_AGENT_CALLER_PROOF: " proof-1 ",
      },
    );

    expect(calls[0]?.[2]).toEqual({ agentId: "agent-1", proof: "proof-1" });
  });

  it("preserves the typed self-archive rejection code", async () => {
    const client = createFakeDaemonClient(async () => ({
      requestId: "req-1",
      workspaceId: "workspace-1",
      archivedAt: null,
      error: "Agent cannot archive its own workspace",
      errorCode: "SELF_ARCHIVE_BLOCKED",
    }));

    await expect(
      runArchiveCommandWithDeps(
        "workspace-1",
        {},
        {
          connectToDaemon: async () => client,
        },
      ),
    ).rejects.toMatchObject({ code: "SELF_ARCHIVE_BLOCKED" });
  });
});
