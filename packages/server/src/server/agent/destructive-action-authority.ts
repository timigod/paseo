import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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
  targetPaths?: readonly string[];
  hasLiveTarget: boolean;
}

export interface LiveAgentAuthority {
  getAgent(agentId: string): {
    id: string;
    workspaceId?: string;
    cwd?: string;
    containmentPaths?: readonly string[];
  } | null;
  isCurrentAgentIncarnation(agentId: string, incarnation: string): boolean;
}

interface DestructiveCallerAuthorityState {
  active: boolean;
}

const callerAuthorities = new WeakMap<object, DestructiveCallerAuthorityState>();

function registerCaller<TCaller extends DestructiveCallerContext>(caller: TCaller): TCaller {
  callerAuthorities.set(caller, { active: true });
  return caller;
}

export function createCoordinatorDestructiveCaller(): DestructiveCallerContext {
  const caller: CoordinatorDestructiveCaller = Object.freeze({ kind: "coordinator" });
  return registerCaller(caller);
}

export function createAgentDestructiveCaller(
  identity: AgentCallerIdentity,
): DestructiveCallerContext {
  return registerCaller({
    kind: "agent",
    identity: Object.freeze({ ...identity }),
  });
}

export function createUncertainDestructiveCaller(reason: string): DestructiveCallerContext {
  return registerCaller({ kind: "uncertain", reason });
}

export function revokeDestructiveCaller(caller: DestructiveCallerContext): void {
  const authority = callerAuthorities.get(caller);
  if (authority) {
    authority.active = false;
  }
}

export function assertDestructiveActionAuthorized(
  authority: LiveAgentAuthority,
  caller: DestructiveCallerContext,
  target: DestructiveActionTarget,
): void {
  if (callerAuthorities.get(caller)?.active !== true) {
    throw invalidCaller();
  }

  if (caller.kind === "coordinator") {
    return;
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
  if (target.targetPaths && callerCheckoutIsWithinTarget(liveCaller, target.targetPaths)) {
    throw selfActionBlocked(target.action);
  }
}

function callerCheckoutIsWithinTarget(
  caller: { cwd?: string; containmentPaths?: readonly string[] },
  targetPaths: readonly string[],
): boolean {
  const callerPaths = [caller.cwd, ...(caller.containmentPaths ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(canonicalizePath);
  const canonicalTargets = targetPaths.filter((value) => value.length > 0).map(canonicalizePath);
  return canonicalTargets.some((targetPath) =>
    callerPaths.some((callerPath) => pathContains(targetPath, callerPath)),
  );
}

function canonicalizePath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function pathContains(container: string, candidate: string): boolean {
  const relation = relative(container, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
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
