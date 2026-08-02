import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { CommandError } from "../output/index.js";

const INVENTORY_PAGE_LIMIT = 200;
const MAX_INVENTORY_PAGES = 1_000;

interface InventoryPageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

interface AgentInventoryPage {
  entries: Array<{ agent: AgentSnapshotPayload }>;
  pageInfo: InventoryPageInfo;
}

interface WorkspaceInventoryPage {
  entries: WorkspaceDescriptorPayload[];
  pageInfo: InventoryPageInfo;
}

export interface AgentInventoryClient {
  fetchAgents(options: {
    scope?: "active";
    filter: { includeArchived: boolean };
    sort: [{ key: "created_at"; direction: "asc" }];
    page: { limit: number; cursor?: string };
    timeout?: number;
  }): Promise<AgentInventoryPage>;
}

export interface WorkspaceInventoryClient {
  fetchWorkspaces(options: {
    filter?: { query: string };
    sort: [{ key: "project_id"; direction: "asc" }];
    page: { limit: number; cursor?: string };
  }): Promise<WorkspaceInventoryPage>;
}

interface FetchAllAgentsOptions {
  includeArchived: boolean;
  scope?: "active";
  timeout?: number;
}

interface FetchAllWorkspacesOptions {
  query?: string;
}

function paginationError(resource: "agent" | "workspace", reason: string): CommandError {
  return {
    code: "INVENTORY_PAGINATION_INCOMPLETE",
    message: `Cannot prove a complete ${resource} inventory`,
    details: reason,
  };
}

export async function fetchAllAgents(
  client: AgentInventoryClient,
  options: FetchAllAgentsOptions,
): Promise<AgentSnapshotPayload[]> {
  const agents: AgentSnapshotPayload[] = [];
  const agentIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_INVENTORY_PAGES; pageNumber += 1) {
    const page = await client.fetchAgents({
      ...(options.scope ? { scope: options.scope } : {}),
      filter: { includeArchived: options.includeArchived },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: INVENTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    for (const { agent } of page.entries) {
      if (agentIds.has(agent.id)) {
        throw paginationError("agent", "The daemon repeated an agent record across pages.");
      }
      agentIds.add(agent.id);
      agents.push(agent);
    }

    const nextCursor = page.pageInfo.nextCursor ?? undefined;
    if (!page.pageInfo.hasMore) {
      if (nextCursor) {
        throw paginationError("agent", "The daemon returned a cursor after the final agent page.");
      }
      return agents;
    }
    if (!nextCursor) {
      throw paginationError("agent", "The daemon omitted the cursor for the next agent page.");
    }
    if (cursors.has(nextCursor)) {
      throw paginationError("agent", "The daemon repeated an agent inventory cursor.");
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw paginationError("agent", `The inventory exceeded ${MAX_INVENTORY_PAGES} pages.`);
}

export async function fetchAllWorkspaces(
  client: WorkspaceInventoryClient,
  options: FetchAllWorkspacesOptions = {},
): Promise<WorkspaceDescriptorPayload[]> {
  const workspaces: WorkspaceDescriptorPayload[] = [];
  const workspaceIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_INVENTORY_PAGES; pageNumber += 1) {
    const page = await client.fetchWorkspaces({
      ...(options.query ? { filter: { query: options.query } } : {}),
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: INVENTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of page.entries) {
      if (workspaceIds.has(workspace.id)) {
        throw paginationError("workspace", "The daemon repeated a workspace record across pages.");
      }
      workspaceIds.add(workspace.id);
      workspaces.push(workspace);
    }

    const nextCursor = page.pageInfo.nextCursor ?? undefined;
    if (!page.pageInfo.hasMore) {
      if (nextCursor) {
        throw paginationError(
          "workspace",
          "The daemon returned a cursor after the final workspace page.",
        );
      }
      return workspaces;
    }
    if (!nextCursor) {
      throw paginationError(
        "workspace",
        "The daemon omitted the cursor for the next workspace page.",
      );
    }
    if (cursors.has(nextCursor)) {
      throw paginationError("workspace", "The daemon repeated a workspace inventory cursor.");
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw paginationError("workspace", `The inventory exceeded ${MAX_INVENTORY_PAGES} pages.`);
}
