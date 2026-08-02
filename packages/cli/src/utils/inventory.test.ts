import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  fetchAllAgents,
  fetchAllWorkspaces,
  type AgentInventoryClient,
  type WorkspaceInventoryClient,
} from "./inventory.js";

function agent(id: string): AgentSnapshotPayload {
  return {
    id,
    provider: "provider-a",
    cwd: "/workspace",
    model: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

function workspace(id: string): WorkspaceDescriptorPayload {
  return { id } as WorkspaceDescriptorPayload;
}

describe("inventory pagination", () => {
  it("reads agent inventories beyond 200 records until exhaustion", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      agent: agent(`agent-${index}`),
    }));
    const fetchAgents = vi.fn<AgentInventoryClient["fetchAgents"]>(async ({ page }) => {
      if (page.cursor === "page-2") {
        return {
          entries: [{ agent: agent("agent-200") }],
          pageInfo: { nextCursor: null, hasMore: false },
        };
      }
      return { entries: firstPage, pageInfo: { nextCursor: "page-2", hasMore: true } };
    });

    const agents = await fetchAllAgents({ fetchAgents }, { includeArchived: false });

    expect(agents).toHaveLength(201);
    expect(agents[200]?.id).toBe("agent-200");
    expect(fetchAgents).toHaveBeenNthCalledWith(1, {
      filter: { includeArchived: false },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: 200 },
    });
    expect(fetchAgents).toHaveBeenNthCalledWith(2, {
      filter: { includeArchived: false },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: 200, cursor: "page-2" },
    });
  });

  it("reads workspace inventories beyond 200 records until exhaustion", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => workspace(`workspace-${index}`));
    const fetchWorkspaces = vi.fn<WorkspaceInventoryClient["fetchWorkspaces"]>(async ({ page }) => {
      if (page.cursor === "page-2") {
        return {
          entries: [workspace("workspace-200")],
          pageInfo: { nextCursor: null, hasMore: false },
        };
      }
      return { entries: firstPage, pageInfo: { nextCursor: "page-2", hasMore: true } };
    });

    const workspaces = await fetchAllWorkspaces({ fetchWorkspaces });

    expect(workspaces).toHaveLength(201);
    expect(workspaces[200]?.id).toBe("workspace-200");
    expect(fetchWorkspaces).toHaveBeenNthCalledWith(1, {
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: 200 },
    });
    expect(fetchWorkspaces).toHaveBeenNthCalledWith(2, {
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: 200, cursor: "page-2" },
    });
  });

  it("fails closed on repeated cursors or duplicate agent records", async () => {
    const repeatedCursor = vi.fn<AgentInventoryClient["fetchAgents"]>(async ({ page }) => ({
      entries: [{ agent: agent(page.cursor ? "agent-2" : "agent-1") }],
      pageInfo: { nextCursor: "same-page", hasMore: true },
    }));
    await expect(
      fetchAllAgents({ fetchAgents: repeatedCursor }, { includeArchived: true }),
    ).rejects.toMatchObject({ code: "INVENTORY_PAGINATION_INCOMPLETE" });

    const duplicateAgent = vi.fn<AgentInventoryClient["fetchAgents"]>(async ({ page }) => ({
      entries: [{ agent: agent("agent-1") }],
      pageInfo: {
        nextCursor: page.cursor ? null : "page-2",
        hasMore: page.cursor === undefined,
      },
    }));
    await expect(
      fetchAllAgents({ fetchAgents: duplicateAgent }, { includeArchived: true }),
    ).rejects.toMatchObject({ code: "INVENTORY_PAGINATION_INCOMPLETE" });
  });

  it("fails closed on repeated cursors or duplicate workspace records", async () => {
    const repeatedCursor = vi.fn<WorkspaceInventoryClient["fetchWorkspaces"]>(async ({ page }) => ({
      entries: [workspace(page.cursor ? "workspace-2" : "workspace-1")],
      pageInfo: { nextCursor: "same-page", hasMore: true },
    }));
    await expect(fetchAllWorkspaces({ fetchWorkspaces: repeatedCursor })).rejects.toMatchObject({
      code: "INVENTORY_PAGINATION_INCOMPLETE",
    });

    const duplicateWorkspace = vi.fn<WorkspaceInventoryClient["fetchWorkspaces"]>(
      async ({ page }) => ({
        entries: [workspace("workspace-1")],
        pageInfo: {
          nextCursor: page.cursor ? null : "page-2",
          hasMore: page.cursor === undefined,
        },
      }),
    );
    await expect(fetchAllWorkspaces({ fetchWorkspaces: duplicateWorkspace })).rejects.toMatchObject(
      { code: "INVENTORY_PAGINATION_INCOMPLETE" },
    );
  });

  it("fails closed when hasMore and nextCursor disagree", async () => {
    const missingCursor = vi.fn<AgentInventoryClient["fetchAgents"]>(async () => ({
      entries: [],
      pageInfo: { nextCursor: null, hasMore: true },
    }));
    await expect(
      fetchAllAgents({ fetchAgents: missingCursor }, { includeArchived: false }),
    ).rejects.toMatchObject({ code: "INVENTORY_PAGINATION_INCOMPLETE" });

    const cursorAfterFinalPage = vi.fn<WorkspaceInventoryClient["fetchWorkspaces"]>(async () => ({
      entries: [],
      pageInfo: { nextCursor: "unexpected", hasMore: false },
    }));
    await expect(
      fetchAllWorkspaces({ fetchWorkspaces: cursorAfterFinalPage }),
    ).rejects.toMatchObject({ code: "INVENTORY_PAGINATION_INCOMPLETE" });
  });
});
