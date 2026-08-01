import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

import type { ForgeService } from "../../services/forge-service.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveResult,
} from "../workspace-archive-service.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../worktree-session.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type {
  CreateAgentWorktreeTarget,
  FirstAgentContext,
  SessionOutboundMessage,
} from "../messages.js";
import type { AgentManager, AgentSubscriber, SubscribeOptions } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./timeline-append.js";

interface CreateAgentLifecycleDispatchDependencies {
  paseoHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  github: ForgeService;
  workspaceGitService: WorkspaceGitService;
  createPaseoWorktreeWorkflow: CreatePaseoWorktreeWorkflowFn;
  archiveAgentForClose: (agentId: string) => Promise<unknown>;
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emit: (message: SessionOutboundMessage) => void;
  emitAgentRemove: (agentId: string) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
}

export interface LifecycleRegistration {
  cancel(): Promise<void>;
}

interface AgentLifecycleEvents {
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
}

const inactiveRegistration: LifecycleRegistration = { cancel: async () => undefined };

type AutoArchiveTarget =
  | { kind: "agent-only" }
  | { kind: "created-worktree"; workspaceId: string; worktreePath?: string };

export class CreateAgentLifecycleDispatch {
  private readonly completedAutoArchiveAgentIds = new Set<string>();
  private readonly autoArchiveTasks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: CreateAgentLifecycleDispatchDependencies) {}

  async createWorktreeForRequest(input: {
    cwd: string;
    target: CreateAgentWorktreeTarget | undefined;
    firstAgentContext: FirstAgentContext;
    hasLegacyGitOptions: boolean;
  }): Promise<CreatePaseoWorktreeWorkflowResult | null> {
    if (input.target && input.hasLegacyGitOptions) {
      throw new Error("create_agent_request worktree cannot be combined with git options");
    }
    if (!input.target) {
      return null;
    }

    return this.createWorktreeForTarget(input.cwd, input.target, input.firstAgentContext);
  }

  registerAutoArchiveIfRequested(input: {
    autoArchive: boolean | undefined;
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }): LifecycleRegistration {
    if (input.autoArchive !== true) {
      return inactiveRegistration;
    }

    return this.registerAutoArchiveOnTerminalState(
      input.agentId,
      toAutoArchiveTarget(input.createdWorktree),
    );
  }

  registerPersistedAutoArchive(
    agentId: string,
    target:
      | { kind: "agent-only" }
      | { kind: "created-worktree"; workspaceId: string; worktreePath: string },
    options?: { startImmediately?: boolean },
  ): LifecycleRegistration {
    return this.registerAutoArchiveOnTerminalState(agentId, target, options);
  }

  async cleanupCreatedWorktreeAfterFailedAgentCreate(input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }): Promise<void> {
    const { createdWorktree, createdAgentId } = input;
    if (!createdWorktree || createdAgentId) {
      return;
    }

    await this.archiveAutoCreatedWorktree({
      agentId: null,
      createdWorktree,
    }).catch((archiveError) => {
      this.dependencies.logger.warn(
        {
          err: archiveError,
          worktreePath: createdWorktree.worktree.worktreePath,
        },
        "Failed to clean up worktree after create_agent_request failed",
      );
    });
  }

  private async createWorktreeForTarget(
    cwd: string,
    target: CreateAgentWorktreeTarget,
    firstAgentContext: FirstAgentContext,
  ): Promise<CreatePaseoWorktreeWorkflowResult> {
    const baseInput = {
      cwd,
      firstAgentContext,
      runSetup: false,
      paseoHome: this.dependencies.paseoHome,
      worktreesRoot: this.dependencies.worktreesRoot,
    } as const;
    const setupContinuation = {
      kind: "agent" as const,
      terminalManager: this.dependencies.terminalManager ?? null,
      appendTimelineItem: ({
        agentId,
        item,
      }: {
        agentId: string;
        item: Parameters<AgentManager["appendTimelineItem"]>[1];
      }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: this.dependencies.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({
        agentId,
        item,
      }: {
        agentId: string;
        item: Parameters<AgentManager["emitLiveTimelineItem"]>[1];
      }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: this.dependencies.agentManager,
          agentId,
          item,
        }),
      logger: this.dependencies.logger,
    };
    const serviceOptions = { setupContinuation };

    switch (target.mode) {
      case "branch-off":
        return this.dependencies.createPaseoWorktreeWorkflow(
          {
            ...baseInput,
            worktreeSlug: target.newBranch,
            action: "branch-off",
            ...(target.base ? { refName: target.base } : {}),
          },
          target.base
            ? { ...serviceOptions, resolveDefaultBranch: async () => target.base! }
            : serviceOptions,
        );
      case "checkout-branch":
        return this.dependencies.createPaseoWorktreeWorkflow(
          { ...baseInput, action: "checkout", refName: target.branch },
          serviceOptions,
        );
      case "checkout-pr":
        return this.dependencies.createPaseoWorktreeWorkflow(
          { ...baseInput, action: "checkout", githubPrNumber: target.prNumber },
          serviceOptions,
        );
      default:
        throw new Error("Unsupported create_agent_request worktree target");
    }
  }

  private registerAutoArchiveOnTerminalState(
    agentId: string,
    target: AutoArchiveTarget,
    options?: { startImmediately?: boolean },
  ): LifecycleRegistration {
    return registerAgentAutoArchive({
      agentManager: this.dependencies.agentManager,
      agentId,
      archive: () => this.autoArchiveAgentOnce(agentId, target),
      onError: (error) =>
        this.dependencies.logger.warn({ err: error, agentId }, "Failed to auto-archive agent"),
      startImmediately: options?.startImmediately,
    });
  }

  private async autoArchiveAgentOnce(agentId: string, target: AutoArchiveTarget): Promise<void> {
    if (this.completedAutoArchiveAgentIds.has(agentId)) return;
    const existing = this.autoArchiveTasks.get(agentId);
    if (existing) return await existing;
    const task = (async () => {
      if (target.kind === "created-worktree") {
        await this.archivePersistedAutoCreatedWorktree(agentId, target);
      } else {
        await this.dependencies.archiveAgentForClose(agentId);
      }
      await this.dependencies.agentStorage.completePendingCreateContinuationStep(
        agentId,
        "autoArchive",
      );
      this.completedAutoArchiveAgentIds.add(agentId);
    })();
    this.autoArchiveTasks.set(agentId, task);
    try {
      await task;
    } finally {
      if (this.autoArchiveTasks.get(agentId) === task) this.autoArchiveTasks.delete(agentId);
    }
  }

  private async archivePersistedAutoCreatedWorktree(
    agentId: string,
    target: Extract<AutoArchiveTarget, { kind: "created-worktree" }>,
  ): Promise<void> {
    const workspace = (await this.dependencies.listActiveWorkspaces()).find(
      (candidate) => candidate.workspaceId === target.workspaceId,
    );
    const worktreePath = target.worktreePath ?? workspace?.cwd;
    if (!worktreePath) {
      throw new Error(`Auto-created workspace ${target.workspaceId} is no longer active`);
    }
    const ownership = await isPaseoOwnedWorktreeCwd(worktreePath, {
      paseoHome: this.dependencies.paseoHome,
      worktreesRoot: this.dependencies.worktreesRoot,
    });
    if (!ownership.allowed) {
      throw new Error("Auto-created worktree is not a Paseo-owned worktree");
    }

    await this.archiveWorkspaceById(target.workspaceId, agentId, worktreePath);
    this.dependencies.emitAgentRemove(agentId);
  }

  private async archiveWorkspaceById(
    workspaceId: string,
    agentId: string | null,
    worktreePath: string,
  ): Promise<void> {
    const workspaceIsActive = (await this.dependencies.listActiveWorkspaces()).some(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    const result = await archiveByScope(
      {
        paseoHome: this.dependencies.paseoHome,
        paseoWorktreesBaseRoot: this.dependencies.worktreesRoot,
        github: this.dependencies.github,
        workspaceGitService: this.dependencies.workspaceGitService,
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        findWorkspaceIdForCwd: this.dependencies.findWorkspaceIdForCwd,
        listActiveWorkspaces: this.dependencies.listActiveWorkspaces,
        archiveWorkspaceRecord: this.dependencies.archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds: this.dependencies.emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving: this.dependencies.markWorkspaceArchiving,
        clearWorkspaceArchiving: this.dependencies.clearWorkspaceArchiving,
        killTerminalsForWorkspace: this.dependencies.killTerminalsForWorkspace,
        sessionLogger: this.dependencies.logger,
      },
      {
        scope: workspaceIsActive
          ? { kind: "workspace", workspaceId }
          : { kind: "worktree", targetPath: worktreePath },
        requestId: randomUUID(),
      },
    );
    requireExactWorkspaceArchive(result, workspaceId, agentId, workspaceIsActive);
  }

  private async archiveAutoCreatedWorktree(options: {
    agentId: string | null;
    createdWorktree: CreatePaseoWorktreeWorkflowResult;
  }): Promise<void> {
    const { createdWorktree } = options;
    const worktreePath = createdWorktree.worktree.worktreePath;
    const ownership = await isPaseoOwnedWorktreeCwd(worktreePath, {
      paseoHome: this.dependencies.paseoHome,
      worktreesRoot: this.dependencies.worktreesRoot,
    });
    if (!ownership.allowed) {
      throw new Error("Auto-created worktree is not a Paseo-owned worktree");
    }

    await this.archiveWorkspaceById(
      createdWorktree.workspace.workspaceId,
      options.agentId,
      worktreePath,
    );

    if (options.agentId) {
      this.dependencies.emitAgentRemove(options.agentId);
    }
  }
}

export function requireExactWorkspaceArchive(
  result: ArchiveResult,
  workspaceId: string,
  agentId: string | null,
  workspaceWasActive = true,
): void {
  if (result.cleanupPending) {
    throw new Error(`Auto-archive cleanup remains pending for workspace ${workspaceId}`);
  }
  if (!result.removedDirectory) {
    throw new Error(`Auto-archive did not remove workspace directory ${workspaceId}`);
  }
  if (workspaceWasActive && !result.archivedWorkspaceIds.includes(workspaceId)) {
    throw new Error(`Auto-archive did not archive requested workspace ${workspaceId}`);
  }
  if (workspaceWasActive && agentId && !result.archivedAgentIds.includes(agentId)) {
    throw new Error(`Auto-archive did not archive requested agent ${agentId}`);
  }
}

export function registerAgentAutoArchive(input: {
  agentManager: AgentLifecycleEvents;
  agentId: string;
  archive: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  retryDelayMs?: number;
  startImmediately?: boolean;
}): LifecycleRegistration {
  let unsubscribe: (() => void) | null = null;
  let archiveTask: Promise<unknown> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseRequested = false;
  let terminalObserved = input.startImmediately === true;
  let cancelled = false;
  const release = () => {
    if (!unsubscribe) {
      releaseRequested = true;
      return;
    }
    const subscribed = unsubscribe;
    unsubscribe = null;
    subscribed();
  };
  const attemptArchive = () => {
    if (cancelled || archiveTask) return;
    const task = Promise.resolve().then(input.archive);
    archiveTask = task;
    void task.then(
      () => release(),
      (error) => {
        if (archiveTask === task) archiveTask = null;
        input.onError?.(error);
        if (!cancelled && terminalObserved && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            attemptArchive();
          }, input.retryDelayMs ?? 1_000);
          retryTimer.unref?.();
        }
      },
    );
  };
  const registration: LifecycleRegistration = {
    async cancel() {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      release();
      await archiveTask;
    },
  };
  unsubscribe = input.agentManager.subscribe(
    (event) => {
      const terminalStream =
        event.type === "agent_stream" &&
        (event.event.type === "turn_completed" ||
          event.event.type === "turn_failed" ||
          event.event.type === "turn_canceled");
      const terminalState =
        event.type === "agent_state" &&
        event.agent.id === input.agentId &&
        event.agent.lastTurnOutcome != null &&
        event.agent.lifecycle !== "running" &&
        event.agent.lifecycle !== "initializing";
      if (!terminalStream && !terminalState) return;
      terminalObserved = true;
      attemptArchive();
    },
    { agentId: input.agentId, replayState: true },
  );
  if (releaseRequested) release();
  if (input.startImmediately) attemptArchive();
  return registration;
}

function toAutoArchiveTarget(
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null,
): AutoArchiveTarget {
  return createdWorktree
    ? {
        kind: "created-worktree",
        workspaceId: createdWorktree.workspace.workspaceId,
        worktreePath: createdWorktree.worktree.worktreePath,
      }
    : { kind: "agent-only" };
}
