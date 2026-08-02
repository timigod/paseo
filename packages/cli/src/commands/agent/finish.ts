import path from "node:path";
import type { Command } from "commander";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { fetchAllAgents, fetchAllWorkspaces } from "../../utils/inventory.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface AgentFinishOptions extends CommandOptions {
  force?: boolean;
  keepWorktree?: boolean;
  host?: string;
}

export interface AgentFinishResult {
  agentId: string;
  status: "finished";
  agent: "archived";
  workspace: "released" | "kept" | "not_present";
  worktree: "released" | "kept" | "not-paseo-owned";
  detail: string;
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

const finishSchema: OutputSchema<AgentFinishResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "AGENT", field: "agent" },
    { header: "WORKSPACE", field: "workspace" },
    { header: "WORKTREE", field: "worktree" },
  ],
};

export function addFinishOptions(command: Command): Command {
  return command
    .description("Archive an agent and release its exclusively owned Paseo workspace")
    .argument("<id>", "Agent ID, prefix, or name")
    .option("--force", "Interrupt and finish a running agent")
    .option("--keep-worktree", "Archive the agent but retain its managed worktree");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function postconditionError(input: {
  agentId: string;
  workspaceId: string | null;
  agent: "archived" | "not_archived";
  workspace: "not_attempted" | "still_present";
}): CommandError {
  return {
    code: "FINISH_POSTCONDITION_FAILED",
    message: "Finish did not reach every required postcondition",
    details: {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      agent: input.agent,
      workspace: input.workspace,
      retry: `Retry paseo agent finish ${input.agentId} after checking daemon health.`,
      recovery:
        "Inspect the named agent and workspace before manual cleanup; no residual resource was deleted automatically.",
    },
  };
}

async function workspaceStillExists(
  client: ConnectedDaemonClient,
  workspaceId: string,
): Promise<boolean> {
  const workspaces = await fetchAllWorkspaces(client, { query: workspaceId });
  return workspaces.some((workspace) => workspace.id === workspaceId);
}

async function resolveExclusiveWorktreePath(
  client: ConnectedDaemonClient,
  agent: AgentSnapshotPayload,
): Promise<string | null> {
  const [agents, workspaces, worktreesResponse] = await Promise.all([
    fetchAllAgents(client, { includeArchived: false }),
    fetchAllWorkspaces(client),
    client.getPaseoWorktreeList({ cwd: agent.cwd }),
  ]);
  if (worktreesResponse.error) {
    throw {
      code: "WORKTREE_LIST_FAILED",
      message: `Cannot inspect Paseo worktrees: ${worktreesResponse.error.message}`,
    } satisfies CommandError;
  }
  const worktree = worktreesResponse.worktrees
    .filter((candidate) => isWithin(candidate.worktreePath, agent.cwd))
    .sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0];
  if (!worktree) return null;
  const hasOtherAgent = agents.some(
    (candidate) =>
      candidate.id !== agent.id &&
      !candidate.archivedAt &&
      isWithin(worktree.worktreePath, candidate.cwd),
  );
  const hasOtherWorkspace = workspaces.some(
    (workspace) =>
      workspace.id !== agent.workspaceId &&
      isWithin(worktree.worktreePath, workspace.workspaceDirectory),
  );
  return hasOtherAgent || hasOtherWorkspace ? null : worktree.worktreePath;
}

async function finishConnectedAgent(
  client: ConnectedDaemonClient,
  agent: AgentSnapshotPayload,
  options: AgentFinishOptions,
): Promise<SingleResult<AgentFinishResult>> {
  const workspaceId = agent.workspaceId ?? null;
  const worktreePath = options.keepWorktree
    ? null
    : await resolveExclusiveWorktreePath(client, agent);

  if (!agent.archivedAt) await client.archiveAgent(agent.id);
  const archivedTarget = await client.fetchAgent({ agentId: agent.id });
  if (!archivedTarget?.agent.archivedAt) {
    throw postconditionError({
      agentId: agent.id,
      workspaceId,
      agent: "not_archived",
      workspace: "not_attempted",
    });
  }

  if (worktreePath) {
    const response = await client.archivePaseoWorktree({ worktreePath, scope: "worktree" });
    if (response.error) {
      throw {
        code: "WORKTREE_ARCHIVE_FAILED",
        message: `Agent was archived but its worktree could not be released: ${response.error.message}`,
      } satisfies CommandError;
    }
  }
  if (workspaceId && worktreePath && (await workspaceStillExists(client, workspaceId))) {
    throw postconditionError({
      agentId: agent.id,
      workspaceId,
      agent: "archived",
      workspace: "still_present",
    });
  }

  let workspace: AgentFinishResult["workspace"] = "not_present";
  if (worktreePath) workspace = "released";
  else if (workspaceId) workspace = "kept";
  let worktree: AgentFinishResult["worktree"] = "not-paseo-owned";
  if (worktreePath) worktree = "released";
  else if (options.keepWorktree) worktree = "kept";

  return {
    type: "single",
    data: {
      agentId: agent.id,
      status: "finished",
      agent: "archived",
      workspace,
      worktree,
      detail: worktreePath
        ? `Archived agent and released Paseo worktree ${path.basename(worktreePath)}.`
        : "Archived agent; no exclusively owned Paseo worktree was released.",
    },
    schema: finishSchema,
  };
}

export async function runFinishCommand(
  agentIdArg: string,
  options: AgentFinishOptions,
  _command: Command,
): Promise<SingleResult<AgentFinishResult>> {
  if (!agentIdArg?.trim()) {
    throw { code: "MISSING_AGENT_ID", message: "Agent ID is required" } satisfies CommandError;
  }

  const host = getDaemonHost({ host: options.host });
  let client: ConnectedDaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (error) {
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies CommandError;
  }

  try {
    const target = await client.fetchAgent({ agentId: agentIdArg });
    if (!target) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
      } satisfies CommandError;
    }
    const agent = target.agent;
    if (agent.status === "running" && !options.force) {
      throw {
        code: "AGENT_RUNNING",
        message: `Agent ${agent.id} is still running`,
        details: "Wait for completion or use --force.",
      } satisfies CommandError;
    }

    return await finishConnectedAgent(client, agent, options);
  } finally {
    await client.close().catch(() => {});
  }
}
