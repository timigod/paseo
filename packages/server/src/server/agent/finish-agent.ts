import path from "node:path";

import {
  fingerprintFinishAgentRequest,
  type FinishAgentOutcome,
  type FinishAgentRequestContext,
  type FinishAgentRequestStore,
  type FinishAgentTarget,
} from "./finish-agent-request-store.js";

export const FINISH_AGENT_ERROR_CODES = {
  agentNotFound: "AGENT_NOT_FOUND",
  agentRunning: "AGENT_RUNNING",
  unconsumedWork: "AGENT_WORK_UNCONSUMED",
  worktreeDirty: "WORKTREE_DIRTY",
  worktreeShared: "WORKTREE_SHARED",
  intentConflict: "FINISH_INTENT_CONFLICT",
} as const;

export type FinishAgentErrorCode =
  (typeof FINISH_AGENT_ERROR_CODES)[keyof typeof FINISH_AGENT_ERROR_CODES];

export class FinishAgentRefusedError extends Error {
  constructor(
    readonly code: FinishAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FinishAgentRefusedError";
  }
}

export interface FinishAgentLiveView {
  cwd: string;
  workspaceId: string | null;
  running: boolean;
  requiresAttention: boolean;
  pendingPermissionCount: number;
}

export interface FinishAgentStoredView {
  cwd: string;
  workspaceId: string | null;
  archivedAt: string | null;
  lastStatus: string | null;
  requiresAttention: boolean;
}

export interface FinishAgentDependencies {
  store: FinishAgentRequestStore;
  getLiveAgent(agentId: string): FinishAgentLiveView | null;
  getStoredAgent(agentId: string): Promise<FinishAgentStoredView | null>;
  listOtherActiveAgentCwds(agentId: string): Promise<string[]>;
  listOtherActiveWorkspaceCwds(workspaceId: string | null): Promise<string[]>;
  listPaseoWorktrees(cwd: string): Promise<string[]>;
  isWorktreeDirty(worktreePath: string): Promise<boolean | null>;
  worktreeStillPresent(worktreePath: string): Promise<boolean>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  releaseWorktree(worktreePath: string): Promise<void>;
}

export interface RunFinishAgentInput {
  agentId: string;
  idempotencyKey: string;
  callerId: string;
  force: boolean;
  keepWorktree: boolean;
}

export async function runFinishAgentCommand(
  dependencies: FinishAgentDependencies,
  input: RunFinishAgentInput,
): Promise<FinishAgentOutcome> {
  return dependencies.store.run({
    key: input.idempotencyKey,
    callerId: input.callerId,
    fingerprint: fingerprintFinishAgentRequest(input),
    authorize: () => authorizeFinishTarget(dependencies, input),
    execute: (context) => executeFinish(dependencies, context),
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

// Resolves and validates the finish target with no side effects. The store
// persists the returned target before the first side effect, so retries reuse
// this exact decision instead of re-deriving it against post-archive state.
async function authorizeFinishTarget(
  dependencies: FinishAgentDependencies,
  input: RunFinishAgentInput,
): Promise<FinishAgentTarget> {
  const live = dependencies.getLiveAgent(input.agentId);
  const stored = await dependencies.getStoredAgent(input.agentId);
  if (!live && !stored) {
    throw new FinishAgentRefusedError(
      FINISH_AGENT_ERROR_CODES.agentNotFound,
      `Agent not found: ${input.agentId}`,
    );
  }

  assertAgentConsumable(input, live, stored);

  const base: Omit<FinishAgentTarget, "worktreePath"> = {
    agentId: input.agentId,
    keepWorktree: input.keepWorktree,
    force: input.force,
  };
  if (input.keepWorktree) {
    return { ...base, worktreePath: null };
  }

  const cwd = live?.cwd ?? stored?.cwd;
  if (!cwd) {
    return { ...base, worktreePath: null };
  }
  const worktreePath = await resolveExclusiveWorktreePath(dependencies, {
    agentId: input.agentId,
    cwd,
    workspaceId: live?.workspaceId ?? stored?.workspaceId ?? null,
  });
  if (worktreePath) {
    const dirty = await dependencies.isWorktreeDirty(worktreePath);
    if (dirty === true) {
      throw new FinishAgentRefusedError(
        FINISH_AGENT_ERROR_CODES.worktreeDirty,
        `Worktree ${worktreePath} has uncommitted changes. Commit or discard them, or finish with keepWorktree.`,
      );
    }
  }
  return { ...base, worktreePath };
}

function assertAgentConsumable(
  input: RunFinishAgentInput,
  live: FinishAgentLiveView | null,
  stored: FinishAgentStoredView | null,
): void {
  if (stored?.archivedAt || input.force) {
    return;
  }
  const running = live ? live.running : stored?.lastStatus === "running";
  if (running) {
    throw new FinishAgentRefusedError(
      FINISH_AGENT_ERROR_CODES.agentRunning,
      `Agent ${input.agentId} is still running. Wait for completion or finish with force.`,
    );
  }
  const unconsumed = live
    ? live.requiresAttention || live.pendingPermissionCount > 0
    : stored?.requiresAttention === true;
  if (unconsumed) {
    throw new FinishAgentRefusedError(
      FINISH_AGENT_ERROR_CODES.unconsumedWork,
      `Agent ${input.agentId} has unconsumed work (pending attention or permission requests). Consume it first or finish with force.`,
    );
  }
}

async function resolveExclusiveWorktreePath(
  dependencies: FinishAgentDependencies,
  agent: { agentId: string; cwd: string; workspaceId: string | null },
): Promise<string | null> {
  const worktreePaths = await dependencies.listPaseoWorktrees(agent.cwd);
  const worktreePath = worktreePaths
    .filter((candidate) => isWithin(candidate, agent.cwd))
    .sort((left, right) => right.length - left.length)[0];
  if (!worktreePath) {
    return null;
  }

  const [otherAgentCwds, otherWorkspaceCwds] = await Promise.all([
    dependencies.listOtherActiveAgentCwds(agent.agentId),
    dependencies.listOtherActiveWorkspaceCwds(agent.workspaceId),
  ]);
  const sharedWith = [...otherAgentCwds, ...otherWorkspaceCwds].filter((candidate) =>
    isWithin(worktreePath, candidate),
  );
  if (sharedWith.length > 0) {
    throw new FinishAgentRefusedError(
      FINISH_AGENT_ERROR_CODES.worktreeShared,
      `Worktree ${worktreePath} is shared with other active agents or workspaces. Finish with keepWorktree to archive the agent only.`,
    );
  }
  return worktreePath;
}

// Each step is idempotent so a retry after a crash or lost response resumes
// from the last durable checkpoint instead of repeating side effects.
async function executeFinish(
  dependencies: FinishAgentDependencies,
  context: FinishAgentRequestContext,
): Promise<void> {
  const { target } = context;
  if (context.phase === "authorized") {
    const stored = await dependencies.getStoredAgent(target.agentId);
    if (stored?.archivedAt) {
      await context.markAgentArchived(stored.archivedAt);
    } else {
      const { archivedAt } = await dependencies.archiveAgent(target.agentId);
      await context.markAgentArchived(archivedAt);
    }
  }
  if (target.worktreePath && (await dependencies.worktreeStillPresent(target.worktreePath))) {
    await dependencies.releaseWorktree(target.worktreePath);
  }
}
