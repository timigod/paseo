export const DESTRUCTIVE_ACTION_ERROR_CODES = {
  invalidCallerIdentity: "INVALID_CALLER_IDENTITY",
  selfActionBlocked: "SELF_ARCHIVE_BLOCKED",
} as const;

export type DestructiveActionErrorCode =
  (typeof DESTRUCTIVE_ACTION_ERROR_CODES)[keyof typeof DESTRUCTIVE_ACTION_ERROR_CODES];

export class DestructiveActionAuthorizationError extends Error {
  constructor(
    readonly code: DestructiveActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DestructiveActionAuthorizationError";
  }
}

export interface AgentCallerIdentity {
  agentId: string;
  incarnation: string;
}

interface AgentDestructiveCaller {
  kind: "agent";
  identity: AgentCallerIdentity;
}

interface CoordinatorDestructiveCaller {
  kind: "coordinator";
}

interface UncertainDestructiveCaller {
  kind: "uncertain";
  reason: string;
}

export type DestructiveCallerContext =
  | AgentDestructiveCaller
  | CoordinatorDestructiveCaller
  | UncertainDestructiveCaller;

export type DestructiveActionName =
  | "agent.archive"
  | "agent.delete"
  | "agent.kill"
  | "agent.finish"
  | "workspace.archive"
  | "worktree.archive";

export interface DestructiveActionTarget {
  action: DestructiveActionName;
  targetAgentIds: readonly string[];
  targetWorkspaceIds: readonly string[];
  hasLiveTarget: boolean;
}

export interface LiveAgentAuthority {
  getAgent(agentId: string): { id: string; workspaceId?: string } | null;
  isCurrentAgentIncarnation(agentId: string, incarnation: string): boolean;
}

const coordinatorAuthorities = new WeakSet<object>();

export function createCoordinatorDestructiveCaller(): DestructiveCallerContext {
  const caller: CoordinatorDestructiveCaller = Object.freeze({ kind: "coordinator" });
  coordinatorAuthorities.add(caller);
  return caller;
}

export function createAgentDestructiveCaller(
  identity: AgentCallerIdentity,
): DestructiveCallerContext {
  return {
    kind: "agent",
    identity: { ...identity },
  };
}

export function createUncertainDestructiveCaller(reason: string): DestructiveCallerContext {
  return { kind: "uncertain", reason };
}

export function assertDestructiveActionAuthorized(
  authority: LiveAgentAuthority,
  caller: DestructiveCallerContext,
  target: DestructiveActionTarget,
): void {
  if (caller.kind === "coordinator") {
    if (coordinatorAuthorities.has(caller)) {
      return;
    }
    throw invalidCaller();
  }

  if (caller.kind === "uncertain") {
    if (!target.hasLiveTarget) {
      return;
    }
    throw invalidCaller();
  }

  const { agentId, incarnation } = caller.identity;
  if (!authority.isCurrentAgentIncarnation(agentId, incarnation)) {
    throw invalidCaller();
  }

  const liveCaller = authority.getAgent(agentId);
  if (!liveCaller) {
    throw invalidCaller();
  }

  if (target.targetAgentIds.includes(agentId)) {
    throw selfActionBlocked(target.action);
  }
  if (liveCaller.workspaceId && target.targetWorkspaceIds.includes(liveCaller.workspaceId)) {
    throw selfActionBlocked(target.action);
  }
}

function invalidCaller(): DestructiveActionAuthorizationError {
  return new DestructiveActionAuthorizationError(
    DESTRUCTIVE_ACTION_ERROR_CODES.invalidCallerIdentity,
    "Destructive action caller identity is missing, stale, or does not match the live agent",
  );
}

function selfActionBlocked(action: DestructiveActionName): DestructiveActionAuthorizationError {
  return new DestructiveActionAuthorizationError(
    DESTRUCTIVE_ACTION_ERROR_CODES.selfActionBlocked,
    `A managed agent cannot target itself with ${action}`,
  );
}
