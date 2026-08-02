import { describe, expect, it, vi } from "vitest";
import { buildFleetDoctorResult, inspectFleetHost, summarizeFleetHostStatus } from "./status.js";
import type { FleetHost } from "./topology.js";

const host: FleetHost = {
  id: "builder-a",
  name: "Builder A",
  endpoint: "secret.internal:6767",
  codeRoot: "/secret/code",
  hostnamePrefixes: ["builder-a"],
  capacity: 10,
};

describe("fleet status", () => {
  it("reports aggregate permission state without exposing diagnostic inventory", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({
      getDaemonStatus: vi.fn().mockResolvedValue({
        version: "0.2.5",
        providers: [{ provider: "provider-a", available: true }],
      }),
      fetchAgents: vi.fn().mockResolvedValue({
        entries: [
          {
            agent: {
              id: "agent-secret",
              title: "Private task title",
              status: "idle",
              pendingPermissions: [
                { id: "permission-1", name: "tool-a", input: { command: "private command" } },
              ],
            },
          },
        ],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      fetchWorkspaces: vi.fn().mockResolvedValue({
        entries: [{ id: "workspace-secret" }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      close,
    });

    const status = await inspectFleetHost({ host, provider: "provider-a", connect });
    const summary = summarizeFleetHostStatus(status);

    expect(summary).toEqual({
      host: "builder-a",
      state: "needs_permission",
      reachable: true,
      providerReady: true,
      agentInventoryReady: true,
      workspaceInventoryReady: true,
      activeAgents: 1,
      pendingPermissions: 1,
      issue: null,
    });
    const statusJson = JSON.stringify(summary);
    for (const secret of [
      host.endpoint,
      host.codeRoot,
      "agent-secret",
      "workspace-secret",
      "Private task title",
      "private command",
    ]) {
      expect(statusJson).not.toContain(secret);
    }

    const doctor = buildFleetDoctorResult([status]);
    expect(doctor.state).toBe("needs_permission");
    expect(doctor.recommendation).toContain("permission");
    const doctorJson = JSON.stringify(doctor);
    for (const secret of [host.endpoint, host.codeRoot, "agent-secret", "workspace-secret"]) {
      expect(doctorJson).not.toContain(secret);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("counts active agents beyond the first inventory page", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      agent: { id: `agent-${index}`, status: "idle", pendingPermissions: [] },
    }));
    const fetchAgents = vi.fn().mockImplementation(({ page }: { page: { cursor?: string } }) =>
      Promise.resolve(
        page.cursor === "page-2"
          ? {
              entries: [{ agent: { id: "agent-200", status: "idle", pendingPermissions: [] } }],
              pageInfo: { nextCursor: null, hasMore: false },
            }
          : {
              entries: firstPage,
              pageInfo: { nextCursor: "page-2", hasMore: true },
            },
      ),
    );
    const connect = vi.fn().mockResolvedValue({
      getDaemonStatus: vi.fn().mockResolvedValue({
        version: "0.2.5",
        providers: [{ provider: "provider-a", available: true }],
      }),
      fetchAgents,
      fetchWorkspaces: vi.fn().mockResolvedValue({
        entries: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const status = await inspectFleetHost({ host, provider: "provider-a", connect });

    expect(summarizeFleetHostStatus(status).activeAgents).toBe(201);
    expect(fetchAgents).toHaveBeenNthCalledWith(1, {
      scope: "active",
      filter: { includeArchived: false },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: 200 },
      timeout: 15_000,
    });
    expect(fetchAgents).toHaveBeenNthCalledWith(2, {
      scope: "active",
      filter: { includeArchived: false },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: 200, cursor: "page-2" },
      timeout: 15_000,
    });
  });

  it("fails workspace inventory closed with a generic public issue", async () => {
    const connect = vi.fn().mockResolvedValue({
      getDaemonStatus: vi.fn().mockResolvedValue({
        version: "0.2.5",
        providers: [{ provider: "provider-a", available: true }],
      }),
      fetchAgents: vi.fn().mockResolvedValue({
        entries: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      fetchWorkspaces: vi.fn().mockRejectedValue(new Error("failed at /secret/code")),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const status = await inspectFleetHost({ host, provider: "provider-a", connect });

    expect(status).toMatchObject({
      reachable: true,
      agentInventoryReady: true,
      workspaceInventoryReady: false,
      workspaceIds: [],
      issue: "workspace inventory probe failed",
    });
    expect(JSON.stringify(summarizeFleetHostStatus(status))).not.toContain("/secret/code");
  });
});
