import path from "node:path";
import { Command } from "commander";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

export interface AgentFinishOptions extends CommandOptions {
  force?: boolean;
  keepWorktree?: boolean;
  host?: string;
}

export interface AgentFinishResult {
  agentId: string;
  status: "finished";
  worktree: "released" | "kept" | "not-paseo-owned";
  detail: string;
}

export type AgentFinishCommandResult = SingleResult<AgentFinishResult>;

export const finishSchema: OutputSchema<AgentFinishResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "WORKTREE", field: "worktree" },
    { header: "DETAIL", field: "detail" },
  ],
};

export function addFinishOptions(cmd: Command): Command {
  return cmd
    .description(
      "Finish a task: archive its agent and release its exclusively owned Paseo worktree",
    )
    .argument("<id>", "Agent ID, prefix, or name")
    .option("--force", "Finish a running agent (interrupts its active run)")
    .option("--keep-worktree", "Archive the agent but retain its managed worktree");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function isOwnedDescendant(
  candidate: AgentSnapshotPayload,
  ownerId: string,
  byId: Map<string, AgentSnapshotPayload>,
): boolean {
  let parentId: string | undefined = candidate.labels?.[PARENT_AGENT_ID_LABEL];
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ownerId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.labels?.[PARENT_AGENT_ID_LABEL];
  }
  return false;
}

function assertFinishable(agent: AgentSnapshotPayload, force: boolean): void {
  if (agent.archivedAt) {
    throw {
      code: "AGENT_ALREADY_ARCHIVED",
      message: `Agent ${agent.id.slice(0, 7)} is already archived`,
      details: "Recover it with: paseo agent recover <id>",
    } satisfies CommandError;
  }
  if (agent.status === "running" && !force) {
    throw {
      code: "AGENT_RUNNING",
      message: `Agent ${agent.id.slice(0, 7)} is still running`,
      details: "Wait for its current turn or use --force to interrupt and finish it.",
    } satisfies CommandError;
  }
}

async function determineWorktreeDisposition(
  client: ConnectedDaemonClient,
  agent: AgentSnapshotPayload,
  options: AgentFinishOptions,
): Promise<{
  worktree: AgentFinishResult["worktree"];
  detail: string;
  path?: string;
}> {
  if (options.keepWorktree) {
    return {
      worktree: "kept",
      detail: "Archived agent; managed worktree retained by request.",
    };
  }

  const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } });
  const agents = agentsPayload.entries.map((entry) => entry.agent);
  const byId = new Map(agents.map((entry) => [entry.id, entry]));
  const worktreeResponse = await client.getPaseoWorktreeList({});
  if (worktreeResponse.error) {
    throw {
      code: "WORKTREE_LIST_FAILED",
      message: `Cannot inspect Paseo worktrees: ${worktreeResponse.error.message}`,
      details: "The agent was not changed. Resolve the daemon error and retry.",
    } satisfies CommandError;
  }
  const worktree = worktreeResponse.worktrees
    .filter((candidate) => isWithin(candidate.worktreePath, agent.cwd))
    .sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0];
  if (!worktree) {
    return {
      worktree: "not-paseo-owned",
      detail: "Archived agent; its workspace is not a Paseo-managed worktree.",
    };
  }

  const unrelatedAgents = agents.filter(
    (candidate) =>
      !candidate.archivedAt &&
      candidate.id !== agent.id &&
      isWithin(worktree.worktreePath, candidate.cwd) &&
      !isOwnedDescendant(candidate, agent.id, byId),
  );
  if (unrelatedAgents.length > 0) {
    return {
      worktree: "kept",
      detail: `Archived agent; retained shared worktree with ${unrelatedAgents.length} unrelated active agent(s).`,
    };
  }
  return {
    worktree: "released",
    detail: `Archived agent and released Paseo worktree ${path.basename(worktree.worktreePath)}.`,
    path: worktree.worktreePath,
  };
}

export async function runFinishCommand(
  agentIdArg: string,
  options: AgentFinishOptions,
  _command: Command,
): Promise<AgentFinishCommandResult> {
  if (!agentIdArg?.trim()) {
    throw {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent finish <id>",
    } satisfies CommandError;
  }

  const host = getDaemonHost({ host: options.host });
  let client: ConnectedDaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }

  try {
    const target = await client.fetchAgent({ agentId: agentIdArg });
    if (!target) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo agent ls --all --global" to find archived and active agents',
      } satisfies CommandError;
    }
    const agent = target.agent;
    assertFinishable(agent, options.force === true);
    const disposition = await determineWorktreeDisposition(client, agent, options);

    await client.archiveAgent(agent.id);
    if (disposition.worktree === "released" && disposition.path) {
      const archived = await client.archivePaseoWorktree({
        worktreePath: disposition.path,
        scope: "worktree",
      });
      if (archived.error) {
        throw {
          code: "WORKTREE_ARCHIVE_FAILED",
          message: `Agent was archived but its worktree could not be released: ${archived.error.message}`,
          details: `Recover the agent with "paseo agent recover ${agent.id}" or inspect the managed worktree before retrying.`,
        } satisfies CommandError;
      }
    }

    await client.close();
    return {
      type: "single",
      data: { agentId: agent.id, status: "finished", ...disposition },
      schema: finishSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}
