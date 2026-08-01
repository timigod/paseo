import type { Logger } from "pino";

import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import { runAsyncWorktreeBootstrap } from "../../worktree-bootstrap.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type {
  AgentWorktreeSetupContinuation,
  CreatePaseoWorktreeSetupContinuationInput,
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { AgentAttachment, FirstAgentContext, GitSetupOptions } from "../../messages.js";
import type { AgentManager, CreateAgentOptions, ManagedAgent } from "../agent-manager.js";
import type { AgentPromptInput, AgentRunOptions, AgentSessionConfig } from "../agent-sdk-types.js";
import {
  type AgentStorage,
  type PendingCreateContinuation,
  type StoredAgentRecord,
} from "../agent-storage.js";
import type { AgentOwner } from "../agent-owner.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { setupFinishNotification, startCreatedAgentInitialPrompt } from "../agent-prompt.js";
import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { buildAgentPrompt, renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { normalizeClientMessageId, resolveClientMessageId } from "../../client-message-id.js";
import { resolveRequiredProviderModel, type ResolvedProviderModel } from "../mcp-shared.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "../timeline-append.js";
import { resolveCreateAgentIntent } from "./intent.js";

export interface CreateAgentSessionWorktreeResult {
  sessionConfig: AgentSessionConfig;
  setupContinuation?: AgentWorktreeSetupContinuation;
  // Set when this build created a fresh worktree workspace. The agent must be
  // stamped with it so workspaceId-scoped archive can find the agent later.
  createdWorkspaceId?: string;
}

export interface CreateAgentCommandDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  paseoHome?: string;
  worktreesRoot?: string;
  terminalManager?: TerminalManager | null;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
  runWorktreeBootstrap?: typeof runAsyncWorktreeBootstrap;
  registerAutoArchive?: (
    agentId: string,
    target: NonNullable<PendingCreateContinuation["autoArchive"]>,
  ) => void;
}

export type EnsureWorkspaceForCreate = (
  cwd: string,
  firstAgentContext?: FirstAgentContext,
) => Promise<string>;

export interface CreateAgentFromSessionInput {
  kind: "session";
  agentId?: string;
  createRequestFingerprint?: string;
  config: AgentSessionConfig;
  workspaceId: string;
  worktreeName?: string;
  initialPrompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  git?: GitSetupOptions;
  labels: Record<string, string>;
  env?: Record<string, string>;
  provisionalTitle: string | null;
  firstAgentContext: FirstAgentContext;
  autoArchiveTarget?: NonNullable<PendingCreateContinuation["autoArchive"]>;
  buildSessionConfig: (
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<CreateAgentSessionWorktreeResult>;
}

export interface CreateAgentFromMcpInput {
  kind: "mcp";
  provider: string;
  title: string;
  initialPrompt?: string;
  config?: Partial<AgentSessionConfig>;
  cwd?: string;
  workspaceId?: string;
  thinking?: string;
  features?: Record<string, unknown>;
  labels?: Record<string, string>;
  mode?: string;
  unattended?: boolean;
  promptFailure?: CreateAgentPromptFailureMode;
  background: boolean;
  notifyOnFinish: boolean;
  internal?: boolean;
  detached?: boolean;
  owner?: AgentOwner;
  env?: Record<string, string>;
  onCreated?: (created: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;
  onWorktreeCreated?: (createdWorktree: CreatePaseoWorktreeWorkflowResult) => void;
  callerAgentId?: string;
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;
  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;
export type CreateAgentPromptFailureMode = "throw" | "log" | "return-error";

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  background: boolean;
  initialPromptStarted: boolean;
  initialPromptError: unknown | null;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export interface CreateAgentCommandHandle {
  snapshot: ManagedAgent;
  completion: Promise<CreateAgentCommandResult>;
  prepareForAcknowledgement: () => Promise<void>;
  acknowledge: (publish: () => void) => void;
  abortBeforeAcknowledgement: (error: unknown) => Promise<void>;
}

export type BoundCreateAgentCommand = (
  input: CreateAgentCommandInput,
) => Promise<CreateAgentCommandResult>;

function requireResolvedWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("createAgentCommand requires a resolved workspaceId");
  }
  return workspaceId;
}

export function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model || provider.includes("/")) {
    return provider;
  }
  return `${provider}/${model}`;
}

function resolveProviderModel(providerValue: string): ResolvedProviderModel {
  const providerInput = providerValue.trim();
  if (providerInput.includes("/")) {
    return resolveRequiredProviderModel(providerInput);
  }
  if (!providerInput) {
    throw new Error("provider is required");
  }
  return { provider: providerInput, model: undefined };
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions: CreateAgentOptions;
  prompt?: AgentPromptInput;
  runOptions?: AgentRunOptions;
  setupContinuation?: AgentWorktreeSetupContinuation;
  background: boolean;
  promptFailure: CreateAgentPromptFailureMode;
  promptLogger?: Logger;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
  autoArchiveTarget?: NonNullable<PendingCreateContinuation["autoArchive"]>;
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const resolved = await resolveCreateAgentCommand(dependencies, input);

  const snapshot = await dependencies.agentManager.createAgent(
    resolved.config,
    input.kind === "session" ? input.agentId : undefined,
    resolved.createOptions,
  );
  return await completeCreateAgentCommand(dependencies, input, resolved, snapshot);
}

export async function beginCreateAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<CreateAgentCommandHandle> {
  const resolved = await resolveSessionCreateAgent(dependencies, input);
  const creation = await dependencies.agentManager.beginAgentCreation(
    resolved.config,
    input.agentId,
    { ...resolved.createOptions, deferPublication: true },
  );
  const snapshot = creation.snapshot;
  const pendingContinuation = buildPendingCreateContinuation(resolved);
  let releaseContinuation!: () => void;
  let rejectContinuation!: (error: unknown) => void;
  let continuationDecided = false;
  const acknowledgement = new Promise<void>((resolve, reject) => {
    releaseContinuation = resolve;
    rejectContinuation = reject;
  });
  const decideOnce = (decision: "continue" | "abort", error?: unknown): boolean => {
    if (continuationDecided) {
      return false;
    }
    continuationDecided = true;
    if (decision === "continue") {
      releaseContinuation();
    } else {
      rejectContinuation(error);
    }
    return true;
  };

  return {
    snapshot,
    completion: Promise.all([acknowledgement, creation.completion]).then(
      async ([, liveSnapshot]) => {
        return await completeCreateAgentCommand(dependencies, input, resolved, liveSnapshot, {
          persistedContinuation: pendingContinuation !== null,
        });
      },
    ),
    prepareForAcknowledgement: async () => {
      if (pendingContinuation) {
        await dependencies.agentStorage.setPendingCreateContinuation(
          snapshot.id,
          pendingContinuation,
        );
      }
    },
    acknowledge: (publish) => {
      creation.commitAcknowledgement(publish);
      decideOnce("continue");
    },
    abortBeforeAcknowledgement: async (error) => {
      if (!decideOnce("abort", error)) {
        return;
      }
      await dependencies.agentManager.abortCreatedAgentBeforeAcknowledgement(snapshot.id, error);
    },
  };
}

async function resolveCreateAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<ResolvedCreateAgent> {
  return input.kind === "session"
    ? await resolveSessionCreateAgent(dependencies, input)
    : await resolveMcpCreateAgent(dependencies, input);
}

async function completeCreateAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
  options?: { persistedContinuation?: boolean },
): Promise<CreateAgentCommandResult> {
  const persistedContinuation = options?.persistedContinuation ?? false;
  registerCreateAutoArchive(dependencies, input, snapshot.id);
  const setupCompletion = startCreateSetupCompletion({
    dependencies,
    resolved,
    agentId: snapshot.id,
    persistedContinuation,
  });
  void setupCompletion?.catch(() => undefined);

  let liveSnapshot = snapshot;
  let initialPromptStarted = false;
  let initialPromptError: unknown | null = null;
  if (input.kind === "mcp") {
    input.onCreated?.({ agentId: snapshot.id, createdWorktree: resolved.createdWorktree ?? null });
  }
  if (resolved.prompt !== undefined) {
    const sendResult = await dispatchCreatedAgentPrompt({
      dependencies,
      resolved,
      snapshot,
      persistedContinuation,
    });
    initialPromptStarted = sendResult.started;
    liveSnapshot = sendResult.liveSnapshot;
    initialPromptError = sendResult.error ?? null;
    if (persistedContinuation && sendResult.started && !sendResult.error) {
      await dependencies.agentStorage.completePendingCreateContinuationStep(snapshot.id, "prompt");
    }
  }

  notifyCreateAgentReady(dependencies, input, snapshot.id, initialPromptStarted);
  await settleCreateSetupCompletion(
    dependencies,
    snapshot.id,
    setupCompletion,
    persistedContinuation,
  );

  return {
    snapshot,
    liveSnapshot,
    background: resolved.background,
    initialPromptStarted,
    initialPromptError,
    ...(resolved.createdWorktree ? { createdWorktree: resolved.createdWorktree } : {}),
  };
}

function registerCreateAutoArchive(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  agentId: string,
): void {
  if (input.kind === "session" && input.autoArchiveTarget) {
    dependencies.registerAutoArchive?.(agentId, input.autoArchiveTarget);
  }
}

function startCreateSetupCompletion(input: {
  dependencies: CreateAgentCommandDependencies;
  resolved: ResolvedCreateAgent;
  agentId: string;
  persistedContinuation: boolean;
}): Promise<void> | null {
  const continuation = input.resolved.setupContinuation;
  if (!continuation) return null;
  const task = input.persistedContinuation
    ? runPendingCreateSetup(input.dependencies, input.agentId, continuation.recovery)
    : Promise.resolve(continuation.startAfterAgentCreate({ agentId: input.agentId }));
  return task.then(async () => {
    if (input.persistedContinuation) {
      await input.dependencies.agentStorage.completePendingCreateContinuationStep(
        input.agentId,
        "setup",
      );
    }
    return undefined;
  });
}

function notifyCreateAgentReady(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  agentId: string,
  initialPromptStarted: boolean,
): void {
  if (
    input.kind !== "mcp" ||
    !input.notifyOnFinish ||
    !input.callerAgentId ||
    !initialPromptStarted
  ) {
    return;
  }
  setupFinishNotification({
    agentManager: dependencies.agentManager,
    agentStorage: dependencies.agentStorage,
    childAgentId: agentId,
    callerAgentId: input.callerAgentId,
    requireParentOwnership: true,
    logger: dependencies.logger,
  });
}

async function settleCreateSetupCompletion(
  dependencies: CreateAgentCommandDependencies,
  agentId: string,
  setupCompletion: Promise<void> | null,
  persistedContinuation: boolean,
): Promise<void> {
  if (!setupCompletion) return;
  if (persistedContinuation) {
    await setupCompletion;
    return;
  }
  void setupCompletion.catch((error) => {
    dependencies.logger.error(
      { err: error, agentId },
      "Failed to finish worktree setup after agent creation",
    );
  });
}

async function dispatchCreatedAgentPrompt(input: {
  dependencies: CreateAgentCommandDependencies;
  resolved: ResolvedCreateAgent;
  snapshot: ManagedAgent;
  persistedContinuation: boolean;
}): Promise<Awaited<ReturnType<typeof sendInitialPrompt>>> {
  if (input.persistedContinuation) {
    await input.dependencies.agentStorage.updatePendingCreateContinuation(
      input.snapshot.id,
      (pending) => ({
        ...pending,
        prompt: pending.prompt ? { ...pending.prompt, status: "dispatching" } : undefined,
      }),
    );
  }
  return await sendInitialPrompt(input.dependencies, input.resolved, input.snapshot);
}

function buildPendingCreateContinuation(
  resolved: ResolvedCreateAgent,
): PendingCreateContinuation | null {
  const prompt = resolved.prompt
    ? {
        status: "pending" as const,
        input: resolved.prompt,
        ...(resolved.runOptions ? { runOptions: resolved.runOptions } : {}),
      }
    : undefined;
  const setup = resolved.setupContinuation?.recovery;
  const autoArchive = inputAutoArchiveTarget(resolved);
  if (!prompt && !setup && !autoArchive) {
    return null;
  }
  return {
    phase: "awaiting_dispatch",
    ...(prompt ? { prompt } : {}),
    ...(setup ? { setup } : {}),
    ...(autoArchive ? { autoArchive } : {}),
  };
}

function inputAutoArchiveTarget(
  resolved: ResolvedCreateAgent,
): NonNullable<PendingCreateContinuation["autoArchive"]> | undefined {
  return resolved.autoArchiveTarget;
}

export async function recoverPendingCreateAgentCommands(
  dependencies: CreateAgentCommandDependencies,
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (options?.signal?.aborted) return;
  const records = await dependencies.agentStorage.list();
  const pendingRecords = records.filter(
    (record) => !record.archivedAt && record.pendingCreateContinuation,
  );
  await Promise.all(
    pendingRecords.map(async (record) => {
      if (options?.signal?.aborted) return;
      try {
        await recoverPendingCreateAgentCommand(dependencies, record, options?.signal);
      } catch (error) {
        dependencies.logger.error(
          { err: error, agentId: record.id },
          "Failed to recover pending create-agent continuation",
        );
      }
    }),
  );
}

const pendingCreateRecoveries = new WeakMap<AgentStorage, Map<string, Promise<void>>>();

export async function recoverPendingCreateAgentCommandById(
  dependencies: CreateAgentCommandDependencies,
  agentId: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  let recoveries = pendingCreateRecoveries.get(dependencies.agentStorage);
  if (!recoveries) {
    recoveries = new Map();
    pendingCreateRecoveries.set(dependencies.agentStorage, recoveries);
  }
  const existing = recoveries.get(agentId);
  if (existing) return await existing;
  const task = (async () => {
    if (options?.signal?.aborted) return;
    const record = await dependencies.agentStorage.get(agentId);
    if (!record?.pendingCreateContinuation || record.archivedAt) return;
    await recoverPendingCreateAgentCommand(dependencies, record, options?.signal);
  })();
  recoveries.set(agentId, task);
  try {
    await task;
  } finally {
    if (recoveries.get(agentId) === task) recoveries.delete(agentId);
  }
}

async function recoverPendingCreateAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  record: StoredAgentRecord,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const pending = record.pendingCreateContinuation;
  if (!pending) {
    return;
  }
  const snapshot = await ensureAgentLoaded(record.id, {
    agentManager: dependencies.agentManager,
    agentStorage: dependencies.agentStorage,
    logger: dependencies.logger,
  });
  if (signal?.aborted) return;
  if (pending.autoArchive) {
    dependencies.registerAutoArchive?.(record.id, pending.autoArchive);
  }
  const setupCompletion = pending.setup
    ? runPendingCreateSetup(dependencies, record.id, pending.setup).then(() =>
        dependencies.agentStorage.completePendingCreateContinuationStep(record.id, "setup"),
      )
    : null;
  void setupCompletion?.catch(() => undefined);

  if (pending.prompt?.status === "dispatching") {
    await dependencies.agentManager.hydrateTimelineFromProvider(record.id, { force: true });
    if (pendingCreatePromptWasAlreadyDispatched(dependencies, snapshot, pending)) {
      await dependencies.agentStorage.completePendingCreateContinuationStep(record.id, "prompt");
    } else {
      throw new Error(
        "Initial prompt dispatch has no provider receipt; refusing an ambiguous duplicate retry",
      );
    }
  } else if (
    pending.prompt &&
    pendingCreatePromptWasAlreadyDispatched(dependencies, snapshot, pending)
  ) {
    await dependencies.agentStorage.completePendingCreateContinuationStep(record.id, "prompt");
  } else if (pending.prompt) {
    if (signal?.aborted) return;
    await dependencies.agentStorage.updatePendingCreateContinuation(record.id, (current) => ({
      ...current,
      prompt: current.prompt ? { ...current.prompt, status: "dispatching" } : undefined,
    }));
    await startCreatedAgentInitialPrompt({
      agentManager: dependencies.agentManager,
      agentId: record.id,
      snapshot,
      prompt: pending.prompt.input,
      runOptions: pending.prompt.runOptions,
      logger: dependencies.logger,
    });
    await dependencies.agentStorage.completePendingCreateContinuationStep(record.id, "prompt");
  }
  await setupCompletion;
}

type PendingCreateSetup = NonNullable<PendingCreateContinuation["setup"]>;

async function runPendingCreateSetup(
  dependencies: CreateAgentCommandDependencies,
  agentId: string,
  setup: PendingCreateSetup,
): Promise<void> {
  if (!setup.shouldBootstrap) {
    return;
  }
  const progress = setup.progress;
  if (!progress) {
    throw new Error("Cannot safely recover worktree setup without a persisted step boundary");
  }
  if (progress.inFlightCommandIndex !== null) {
    throw new Error(
      `Worktree setup stopped with command ${progress.inFlightCommandIndex + 1} in flight; refusing to replay it`,
    );
  }
  if (progress.terminals === "running") {
    throw new Error("Worktree terminal bootstrap stopped in flight; refusing to replay it");
  }
  if (progress.terminals === "completed") {
    return;
  }

  const updateProgress = async (
    update: (
      current: NonNullable<PendingCreateSetup["progress"]>,
    ) => NonNullable<PendingCreateSetup["progress"]>,
  ): Promise<void> => {
    await dependencies.agentStorage.updatePendingCreateContinuation(agentId, (pending) => {
      if (!pending.setup?.progress) {
        throw new Error(`Agent ${agentId} lost its persisted worktree setup boundary`);
      }
      return {
        ...pending,
        setup: { ...pending.setup, progress: update(pending.setup.progress) },
      };
    });
  };

  await (dependencies.runWorktreeBootstrap ?? runAsyncWorktreeBootstrap)({
    agentId,
    workspaceId: setup.workspaceId,
    worktree: setup.worktree,
    workspaceCwd: setup.workspaceCwd,
    shouldBootstrap: true,
    terminalManager: dependencies.terminalManager ?? null,
    setupProgress: progress,
    beforeSetupCommand: async (index) => {
      await updateProgress((current) => ({ ...current, inFlightCommandIndex: index }));
    },
    afterSetupCommand: async (index) => {
      await updateProgress((current) => ({
        ...current,
        nextCommandIndex: index + 1,
        inFlightCommandIndex: null,
      }));
    },
    beforeTerminalBootstrap: async () => {
      await updateProgress((current) => ({ ...current, terminals: "running" }));
    },
    afterTerminalBootstrap: async () => {
      await updateProgress((current) => ({ ...current, terminals: "completed" }));
    },
    throwOnFailure: true,
    appendTimelineItem: (item) =>
      appendTimelineItemIfAgentKnown({ agentManager: dependencies.agentManager, agentId, item }),
    emitLiveTimelineItem: (item) =>
      emitLiveTimelineItemIfAgentKnown({ agentManager: dependencies.agentManager, agentId, item }),
    logger: dependencies.logger,
  });
}

function pendingCreatePromptWasAlreadyDispatched(
  dependencies: CreateAgentCommandDependencies,
  snapshot: ManagedAgent,
  pending: PendingCreateContinuation,
): boolean {
  const prompt = pending.prompt;
  if (!prompt) {
    return false;
  }

  const clientMessageId = prompt.runOptions?.clientMessageId;
  return dependencies.agentManager.getTimeline(snapshot.id).some((item) => {
    if (item.type !== "user_message") {
      return false;
    }
    if (clientMessageId && item.clientMessageId === clientMessageId) {
      return true;
    }
    if (clientMessageId && item.messageId === clientMessageId) {
      return true;
    }
    return renderPendingPromptText(prompt.input).some((text) => item.text === text);
  });
}

function renderPendingPromptText(
  input: PendingCreateContinuation["prompt"] extends infer Prompt
    ? Prompt extends { input: infer Input }
      ? Input
      : never
    : never,
): string[] {
  if (typeof input === "string") return [input];
  const withoutImages = input
    .filter((block) => block.type !== "image")
    .map((block) => (block.type === "text" ? block.text : renderPromptAttachmentAsText(block)))
    .filter((text) => text.trim().length > 0)
    .join("\n");
  const withImageMarkers = input
    .map((block) => {
      if (block.type === "image") return "[Image]";
      return block.type === "text" ? block.text : renderPromptAttachmentAsText(block);
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
  return [...new Set([withoutImages, withImageMarkers].filter(Boolean))];
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const {
    sessionConfig: builtSessionConfig,
    setupContinuation,
    createdWorkspaceId,
  } = await input.buildSessionConfig(
    input.config,
    input.git,
    input.worktreeName,
    input.firstAgentContext,
  );
  // Validate the requested mode against the provider's modes for the resolved
  // cwd. The app remembers mode preferences globally, so a saved mode can be
  // stale for a workspace whose provider config no longer defines it — reject
  // it here instead of letting the provider fail mid-turn.
  //
  // This runs after buildSessionConfig, which may already have created a
  // worktree and/or workspace record — cwd (required to resolve modes) is
  // only known once that step completes. If validation throws, any
  // worktree/workspace buildSessionConfig created is the caller's
  // responsibility to clean up (session.ts's handleCreateAgentRequest does
  // this for the worktree path via cleanupCreatedWorktreeAfterFailedAgentCreate;
  // this is a pre-existing gap for directory-only workspace creates, not
  // introduced by this validation).
  const resolvedCreateConfig = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: builtSessionConfig.cwd,
    provider: builtSessionConfig.provider,
    requestedMode: builtSessionConfig.modeId,
    featureValues: builtSessionConfig.featureValues,
    parent: null,
    unattended: false,
  });
  const sessionConfig: AgentSessionConfig = {
    ...builtSessionConfig,
    modeId: resolvedCreateConfig.modeId,
    featureValues: resolvedCreateConfig.featureValues,
  };
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  const normalizedClientMessageId = normalizeClientMessageId(input.clientMessageId);
  const clientMessageId = hasPromptContent
    ? (normalizedClientMessageId ?? resolveClientMessageId(undefined))
    : normalizedClientMessageId;
  const runOptions: AgentRunOptions | undefined =
    input.outputSchema || clientMessageId
      ? {
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        }
      : undefined;
  const workspaceId = setupContinuation ? createdWorkspaceId : input.workspaceId;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      initialPrompt: trimmedPrompt,
      env: input.env,
      initialTitle: input.provisionalTitle,
      createRequestFingerprint: input.createRequestFingerprint,
      // A legacy git/worktreeName worktree creates a fresh workspace, so the
      // agent belongs to that workspace, not the source one. createdWorkspaceId
      // is the freshly created worktree's workspace.
      workspaceId: requireResolvedWorkspaceId(workspaceId),
    },
    prompt: hasPromptContent ? prompt : undefined,
    runOptions,
    setupContinuation,
    background: true,
    promptFailure: "throw",
    promptLogger: dependencies.logger.child({
      clientMessageId: clientMessageId ?? resolveClientMessageId(undefined),
    }),
    autoArchiveTarget: input.autoArchiveTarget,
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  const cwd = resolveMcpInitialCwd(input, parentAgent);
  const { resolvedCwd, setupContinuation, createdWorkspaceId, createdWorktree } =
    await resolveMcpCwd({
      dependencies,
      cwd,
      worktree: input.worktree,
      initialPrompt: input.initialPrompt ?? "",
    });
  if (createdWorktree) input.onWorktreeCreated?.(createdWorktree);

  const intent = await resolveCreateAgentIntent({
    explicitWorkspaceId: setupContinuation ? createdWorkspaceId : input.workspaceId,
    caller: parentAgent
      ? { id: parentAgent.id, cwd: parentAgent.cwd, workspaceId: parentAgent.workspaceId }
      : null,
    labels: input.labels,
    childAgentDefaultLabels: input.callerContext?.childAgentDefaultLabels,
    legacyDetached: input.detached ?? false,
    resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: resolvedCwd }),
    createWorkspace: async () => ({
      workspaceId: requireResolvedWorkspaceId(
        await ensureWorkspaceForMcpCreate(dependencies, resolvedCwd, input.initialPrompt ?? ""),
      ),
      cwd: resolvedCwd,
    }),
  });
  const resolvedCreateConfig = await resolveMcpProviderCreateConfig({
    dependencies,
    input,
    provider,
    resolvedCwd,
    parentAgent,
  });

  const trimmedPrompt = input.initialPrompt?.trim() ?? "";
  return {
    config: buildMcpSessionConfig({
      input,
      resolvedProviderModel,
      provider,
      resolvedCwd: intent.cwd,
      trimmedPrompt,
      resolvedMode: resolvedCreateConfig.modeId,
      resolvedFeatures: resolvedCreateConfig.featureValues,
    }),
    createOptions: {
      ...(Object.keys(intent.labels).length > 0 ? { labels: intent.labels } : {}),
      workspaceId: intent.workspaceId,
      owner: input.owner,
      env: input.env,
    },
    prompt: trimmedPrompt ? trimmedPrompt : undefined,
    setupContinuation,
    createdWorktree,
    background: input.background,
    promptFailure: input.promptFailure ?? "log",
  };
}

function resolveMcpInitialCwd(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): string {
  if (!parentAgent) {
    return expandUserPath(input.cwd ?? process.cwd());
  }
  return resolveChildAgentCwd({
    parentCwd: parentAgent.cwd,
    requestedCwd: input.cwd,
    lockedCwd: input.callerContext?.lockedCwd,
    allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
  });
}

async function resolveMcpProviderCreateConfig(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  provider: string;
  resolvedCwd: string;
  parentAgent: ManagedAgent | null;
}): Promise<{ modeId?: string; featureValues?: Record<string, unknown> }> {
  const passthroughConfig = params.input.config;
  return params.dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: params.resolvedCwd,
    provider: params.provider,
    requestedMode: params.input.mode ?? passthroughConfig?.modeId,
    featureValues: params.input.features ?? passthroughConfig?.featureValues,
    parent: params.parentAgent,
    unattended: params.input.unattended ?? false,
  });
}

function buildMcpSessionConfig(params: {
  input: CreateAgentFromMcpInput;
  resolvedProviderModel: ResolvedProviderModel;
  provider: string;
  resolvedCwd: string;
  trimmedPrompt: string;
  resolvedMode?: string;
  resolvedFeatures?: Record<string, unknown>;
}): AgentSessionConfig {
  const passthroughConfig = params.input.config;
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: passthroughConfig?.title ?? params.input.title,
    initialPrompt: params.trimmedPrompt,
  });
  const featureValues = params.resolvedFeatures ?? passthroughConfig?.featureValues;
  const config: AgentSessionConfig = {
    ...passthroughConfig,
    provider: params.provider,
    cwd: params.resolvedCwd,
    modeId: params.resolvedMode ?? passthroughConfig?.modeId,
    model: params.resolvedProviderModel.model ?? passthroughConfig?.model,
    thinkingOptionId: params.input.thinking ?? passthroughConfig?.thinkingOptionId,
    internal: params.input.internal ?? passthroughConfig?.internal,
  };
  if (provisionalTitle) {
    config.title = provisionalTitle;
  }
  if (featureValues) {
    config.featureValues = featureValues;
  }
  return config;
}

async function ensureWorkspaceForMcpCreate(
  dependencies: CreateAgentCommandDependencies,
  cwd: string,
  initialPrompt: string,
): Promise<string | undefined> {
  if (!dependencies.ensureWorkspaceForCreate) {
    return undefined;
  }
  return dependencies.ensureWorkspaceForCreate(cwd, { prompt: initialPrompt });
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent; error?: unknown }> {
  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    const liveSnapshot = await startCreatedAgentInitialPrompt({
      agentManager: dependencies.agentManager,
      agentId: snapshot.id,
      snapshot,
      prompt,
      runOptions: resolved.runOptions,
      logger: resolved.promptLogger ?? dependencies.logger,
    });
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    if (resolved.promptFailure === "return-error") {
      return { started: false, liveSnapshot: snapshot, error };
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  initialPrompt: string;
  worktree: CreateAgentFromMcpInput["worktree"];
}): Promise<{
  resolvedCwd: string;
  setupContinuation?: AgentWorktreeSetupContinuation;
  createdWorkspaceId?: string;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = Boolean(
    worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber,
  );
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      worktreeSlug: worktree.worktreeName,
      branchName: worktree.branchName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      firstAgentContext: { prompt: params.initialPrompt },
      runSetup: false,
      paseoHome: dependencies.paseoHome,
      worktreesRoot: dependencies.worktreesRoot,
    },
    createPaseoWorktree: dependencies.createPaseoWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
    setupContinuation: {
      kind: "agent",
      terminalManager: dependencies.terminalManager ?? null,
      appendTimelineItem: ({ agentId, item }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({ agentId, item }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      logger: dependencies.logger,
    },
  });
  return {
    resolvedCwd: createdWorktree.workspace.cwd,
    setupContinuation: createdWorktree.setupContinuation,
    createdWorkspaceId: createdWorktree.workspace.workspaceId,
    createdWorktree,
  };
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Paseo worktree service is not configured");
    }
    return await options.createPaseoWorktree(options.input, {
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      ...(options.setupContinuation ? { setupContinuation: options.setupContinuation } : {}),
    });
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}
