import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  DestructiveMembershipGate,
  type DestructiveMembershipScope,
} from "./destructive-membership-gate.js";
import { areEquivalentPaths, normalizePathForIdentity } from "../utils/path.js";
import {
  generateProjectId,
  type PersistedProjectKind,
  type PersistedWorkspaceKind,
} from "./workspace-registry-model.js";

const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // COMPAT(projectKey): added in v0.2.4 on 2026-07-28; remove optional after 2027-01-28.
  projectKey: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // User-set override layered over the derived displayName. Reconciliation
  // never touches this. Null means "use the derived name". Added for #987.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const PersistedWorkspaceCleanupPendingSchema = z.object({
  directoryPath: z.string(),
  teardownCwd: z.string(),
  mainRepoRoot: z.string().nullable(),
  paseoWorktreesRoot: z.string().nullable(),
  // COMPAT(cleanupIncarnation): legacy path-only cleanup records fail closed.
  worktreeIncarnationId: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // COMPAT(cleanupQuarantineMarker): added in v0.2.6; unmarked records may
  // quarantine an authenticated original path but cannot claim a quarantine.
  quarantineMarker: z.string().uuid().nullable().optional(),
});

const PersistedWorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  displayName: z.string(),
  // User-set title layered over the derived displayName. In Model B the title is
  // the workspace identity; branch/directory are backing metadata. Reconciliation
  // never touches this. Null means "use the derived displayName".
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The worktree's git branch. Decoupled from displayName/title by construction:
  // displayName holds the human name (title), branch holds the git branch. Only
  // worktree workspaces carry a branch; directory/local_checkout leave it null.
  branch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Exact checkout/worktree root backing cwd. This differs from cwd when the
  // selected project is a subdirectory inside a repository. Persist it so
  // archive and recovery do not need the directory to still exist in order to
  // recover placement.
  worktreeRoot: z.string().nullable().default(null),
  // The base branch the worktree was created from (normalized like worktree.json's
  // baseRefName). Only worktree workspaces carry a base branch; checkout-branch
  // worktrees and directory/local_checkout workspaces leave it null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  isPaseoOwnedWorktree: z.boolean().default(false),
  mainRepoRoot: z.string().nullable().default(null),
  cleanupPending: PersistedWorkspaceCleanupPendingSchema.nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  pinnedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;
export type PersistedWorkspaceCleanupPending = z.infer<
  typeof PersistedWorkspaceCleanupPendingSchema
>;

export interface WorkspaceMutation {
  kind: "upsert" | "archive" | "remove";
  workspaceId: string;
  workspace: PersistedWorkspaceRecord | null;
  expectsInitialAgent?: boolean;
}

export interface WorkspaceMutationContext {
  expectsInitialAgent?: boolean;
}

export interface RegistryArchiveOptions {
  recheck?: () => void | Promise<void>;
}

export interface ProjectMutation {
  kind: "upsert" | "archive" | "remove";
  projectId: string;
  project: PersistedProjectRecord | null;
}

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    projectKey?: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  remove(projectId: string, options: RegistryArchiveOptions): Promise<void>;
  /** Central lifecycle seam for daemon-global project observers. */
  subscribeToMutations?(listener: (mutation: ProjectMutation) => void | Promise<void>): () => void;
}

export interface WorkspaceRegistry {
  getMembershipVersion?(): number;
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedWorkspaceRecord[]>;
  get(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null>;
  upsert(record: PersistedWorkspaceRecord, context?: WorkspaceMutationContext): Promise<void>;
  archive(workspaceId: string, archivedAt: string, options?: RegistryArchiveOptions): Promise<void>;
  remove(workspaceId: string, options?: RegistryArchiveOptions): Promise<void>;
  /** Central lifecycle seam for daemon-global workspace observers. */
  subscribeToMutations?(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void;
}

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private readonly membershipGate: DestructiveMembershipGate | null;
  private readonly resolveMembershipMutationScope:
    | ((existing: TRecord | null, next: TRecord) => DestructiveMembershipScope | null)
    | null;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly cache = new Map<string, TRecord>();
  private persistQueue: Promise<void> = Promise.resolve();
  private membershipVersion = 0;
  private membershipMutationsInFlight = 0;

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
    membershipGate?: DestructiveMembershipGate;
    resolveMembershipMutationScope?: (
      existing: TRecord | null,
      next: TRecord,
    ) => DestructiveMembershipScope | null;
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.membershipGate = options.membershipGate ?? null;
    this.resolveMembershipMutationScope = options.resolveMembershipMutationScope ?? null;
    this.logger = options.logger.child({
      module: "workspace-registry",
      component: options.component,
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  getMembershipVersion(): number {
    return this.membershipMutationsInFlight > 0 ? Number.NaN : this.membershipVersion;
  }

  async upsert(record: TRecord): Promise<void> {
    await this.load();
    const parsed = this.schema.parse(record);
    await this.enqueueOperation(async () => {
      const id = this.getId(parsed);
      const existing = this.cache.get(id) ?? null;
      const membershipScope = this.resolveMembershipMutationScope?.(existing, parsed) ?? null;
      const membershipLease = membershipScope
        ? this.membershipGate?.beginMembershipMutation(membershipScope)
        : null;
      const finishMembershipTracking = membershipScope
        ? this.beginMembershipMutationTracking()
        : null;
      try {
        const records = Array.from(this.cache.values(), (current) =>
          this.getId(current) === id ? parsed : current,
        );
        if (!this.cache.has(id)) {
          records.push(parsed);
        }
        await this.persistRecords(records);
        this.cache.set(id, parsed);
      } finally {
        finishMembershipTracking?.();
        membershipLease?.release();
      }
    });
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    await this.load();
    return this.enqueueOperation(async () => {
      const existing = this.cache.get(id);
      if (!existing) {
        return null;
      }
      const next = this.schema.parse(updater(existing));
      const membershipScope = this.resolveMembershipMutationScope?.(existing, next) ?? null;
      const membershipLease = membershipScope
        ? this.membershipGate?.beginMembershipMutation(membershipScope)
        : null;
      const finishMembershipTracking = membershipScope
        ? this.beginMembershipMutationTracking()
        : null;
      try {
        const records = Array.from(this.cache.values(), (current) =>
          this.getId(current) === id ? next : current,
        );
        await this.persistRecords(records);
        this.cache.set(id, next);
        return next;
      } finally {
        finishMembershipTracking?.();
        membershipLease?.release();
      }
    });
  }

  async archive(id: string, archivedAt: string, options?: RegistryArchiveOptions): Promise<void> {
    await this.archiveIfPresent(id, archivedAt, options);
  }

  protected async archiveIfPresent(
    id: string,
    archivedAt: string,
    options?: RegistryArchiveOptions,
  ): Promise<TRecord | null> {
    await this.load();
    return this.persistArchive(id, archivedAt, options);
  }

  protected async archiveIfActive(id: string, archivedAt: string): Promise<TRecord | null> {
    await this.load();
    return this.persistArchive(id, archivedAt, undefined, {
      onlyIfActive: true,
    });
  }

  private async persistArchive(
    id: string,
    archivedAt: string,
    options?: RegistryArchiveOptions,
    behavior?: { onlyIfActive?: boolean },
  ): Promise<TRecord | null> {
    return this.enqueueOperation(async () => {
      const current = this.cache.get(id);
      if (!current || (behavior?.onlyIfActive && current.archivedAt)) {
        return null;
      }
      const finishMembershipTracking = this.beginMembershipMutationTracking();
      try {
        await options?.recheck?.();
        const next = this.schema.parse({
          ...current,
          updatedAt: archivedAt,
          archivedAt,
        });
        const records = Array.from(this.cache.values(), (record) =>
          this.getId(record) === id ? next : record,
        );
        await this.persistRecords(records, options?.recheck);
        this.cache.set(id, next);
        return next;
      } finally {
        finishMembershipTracking();
      }
    });
  }

  async remove(id: string, options?: RegistryArchiveOptions): Promise<void> {
    await this.removeIfPresent(id, options);
  }

  protected async removeIfPresent(
    id: string,
    options?: RegistryArchiveOptions,
  ): Promise<TRecord | null> {
    await this.load();
    return this.enqueueOperation(async () => {
      const current = this.cache.get(id);
      if (!current) {
        return null;
      }
      const finishMembershipTracking = this.beginMembershipMutationTracking();
      try {
        await options?.recheck?.();
        const records = Array.from(this.cache.values()).filter(
          (record) => this.getId(record) !== id,
        );
        await this.persistRecords(records, options?.recheck);
        this.cache.delete(id);
        return current;
      } finally {
        finishMembershipTracking();
      }
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loadPromise ??= this.enqueueOperation(async () => {
      if (this.loaded) {
        return;
      }

      this.cache.clear();
      try {
        const raw = await fs.readFile(this.filePath, "utf8");
        const parsed = z.array(this.schema).parse(JSON.parse(raw));
        for (const record of parsed) {
          this.cache.set(this.getId(record), record);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          this.logger.error(
            { err: error, filePath: this.filePath },
            "Failed to load registry file",
          );
        }
      }
      this.loaded = true;
    });

    await this.loadPromise;
  }

  private async persistRecords(
    records: readonly TRecord[],
    recheck?: () => void | Promise<void>,
  ): Promise<void> {
    await writeJsonFileAtomic(this.filePath, records, {
      beforeCommit: recheck,
    });
  }

  private async enqueueOperation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const nextOperation = this.persistQueue.then(operation);
    this.persistQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }

  private beginMembershipMutationTracking(): () => void {
    this.membershipVersion += 1;
    this.membershipMutationsInFlight += 1;
    return () => {
      this.membershipVersion += 1;
      this.membershipMutationsInFlight -= 1;
    };
  }
}

function projectMembershipMutationScope(
  existing: PersistedProjectRecord | null,
  next: PersistedProjectRecord,
): DestructiveMembershipScope | null {
  if (next.archivedAt && (!existing || existing.archivedAt)) {
    return null;
  }
  if (
    existing &&
    existing.archivedAt === next.archivedAt &&
    areEquivalentPaths(existing.rootPath, next.rootPath)
  ) {
    return null;
  }
  return {
    projectIds: [next.projectId],
    paths: Array.from(
      new Set(
        [existing?.rootPath, next.rootPath]
          .filter((candidate): candidate is string => typeof candidate === "string")
          .map(normalizePathForIdentity),
      ),
    ),
  };
}

function workspaceMembershipMutationScope(
  existing: PersistedWorkspaceRecord | null,
  next: PersistedWorkspaceRecord,
): DestructiveMembershipScope | null {
  if (next.archivedAt && (!existing || existing.archivedAt)) {
    return null;
  }
  if (
    existing &&
    existing.projectId === next.projectId &&
    existing.archivedAt === next.archivedAt &&
    existing.kind === next.kind &&
    existing.isPaseoOwnedWorktree === next.isPaseoOwnedWorktree &&
    existing.worktreeRoot === next.worktreeRoot &&
    existing.mainRepoRoot === next.mainRepoRoot &&
    areEquivalentPaths(existing.cwd, next.cwd)
  ) {
    return null;
  }
  return {
    workspaceIds: [next.workspaceId],
    projectIds: Array.from(
      new Set(
        [existing?.projectId, next.projectId].filter(
          (candidate): candidate is string => typeof candidate === "string",
        ),
      ),
    ),
    paths: Array.from(
      new Set(
        [existing?.cwd, existing?.worktreeRoot, next.cwd, next.worktreeRoot]
          .filter((candidate): candidate is string => typeof candidate === "string")
          .map(normalizePathForIdentity),
      ),
    ),
  };
}

export class FileBackedProjectRegistry
  extends FileBackedRegistry<PersistedProjectRecord>
  implements ProjectRegistry
{
  private allocationQueue: Promise<void> = Promise.resolve();
  private readonly projectIdFactory: () => string;
  private readonly mutationListeners = new Set<
    (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>
  >();
  constructor(
    filePath: string,
    logger: Logger,
    options?: {
      projectIdFactory?: () => string;
      membershipGate?: DestructiveMembershipGate;
    },
  ) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
      membershipGate: options?.membershipGate,
      resolveMembershipMutationScope: projectMembershipMutationScope,
    });
    this.projectIdFactory = options?.projectIdFactory ?? generateProjectId;
  }

  async getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    projectKey?: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord> {
    const previous = this.allocationQueue;
    let release!: () => void;
    this.allocationQueue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const active = (await this.list())
        .filter(
          (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, input.rootPath),
        )
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.projectId.localeCompare(right.projectId),
        )[0];
      if (active) {
        if (active.kind === input.kind && active.projectKey === (input.projectKey ?? null))
          return active;
        const refreshed = {
          ...active,
          kind: input.kind,
          projectKey: input.projectKey ?? null,
          updatedAt: input.timestamp,
        };
        await this.upsert(refreshed);
        return refreshed;
      }

      for (;;) {
        const projectId = this.projectIdFactory();
        if (await this.get(projectId)) continue;
        const record = createPersistedProjectRecord({
          projectId,
          rootPath: input.rootPath,
          kind: input.kind,
          displayName: input.displayName,
          projectKey: input.projectKey ?? null,
          createdAt: input.timestamp,
          updatedAt: input.timestamp,
        });
        await this.upsert(record);
        return record;
      }
    } finally {
      release();
    }
  }

  subscribeToMutations(
    listener: (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async upsert(record: PersistedProjectRecord): Promise<void> {
    await super.upsert(record);
    await this.notifyMutation({ kind: "upsert", projectId: record.projectId, project: record });
  }

  override async archive(projectId: string, archivedAt: string): Promise<void> {
    const project = await this.archiveIfActive(projectId, archivedAt);
    if (!project) return;
    await this.notifyMutation({ kind: "archive", projectId, project });
  }

  override async remove(projectId: string, options: RegistryArchiveOptions): Promise<void> {
    const recheck = options?.recheck;
    if (typeof recheck !== "function") {
      throw new Error("Project removal requires a commit-time authority recheck");
    }
    const project = await this.removeIfPresent(projectId, { recheck });
    if (!project) return;
    await this.notifyMutation({ kind: "remove", projectId, project: null });
  }

  private async notifyMutation(mutation: {
    kind: "upsert" | "archive" | "remove";
    projectId: string;
    project: PersistedProjectRecord | null;
  }): Promise<void> {
    await Promise.all([...this.mutationListeners].map((listener) => listener(mutation)));
  }
}

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  private readonly mutationListeners = new Set<
    (mutation: WorkspaceMutation) => void | Promise<void>
  >();

  constructor(
    filePath: string,
    logger: Logger,
    options?: { membershipGate?: DestructiveMembershipGate },
  ) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
      membershipGate: options?.membershipGate,
      resolveMembershipMutationScope: workspaceMembershipMutationScope,
    });
  }

  subscribeToMutations(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null> {
    const workspace = await super.update(workspaceId, updater);
    if (workspace) {
      await this.notifyMutation({ kind: "upsert", workspaceId, workspace });
    }
    return workspace;
  }

  override async upsert(
    record: PersistedWorkspaceRecord,
    context?: WorkspaceMutationContext,
  ): Promise<void> {
    await super.upsert(record);
    await this.notifyMutation({
      kind: "upsert",
      workspaceId: record.workspaceId,
      workspace: record,
      ...(context?.expectsInitialAgent ? { expectsInitialAgent: true } : {}),
    });
  }

  override async archive(
    workspaceId: string,
    archivedAt: string,
    options?: RegistryArchiveOptions,
  ): Promise<void> {
    const workspace = await this.archiveIfPresent(workspaceId, archivedAt, options);
    if (!workspace) return;
    await this.notifyMutation({ kind: "archive", workspaceId, workspace });
  }

  override async remove(workspaceId: string, options?: RegistryArchiveOptions): Promise<void> {
    const workspace = await this.removeIfPresent(workspaceId, options);
    if (!workspace) return;
    await this.notifyMutation({ kind: "remove", workspaceId, workspace: null });
  }

  private async notifyMutation(mutation: WorkspaceMutation): Promise<void> {
    await Promise.all([...this.mutationListeners].map((listener) => listener(mutation)));
  }
}

export function createPersistedProjectRecord(input: {
  projectId: string;
  rootPath: string;
  kind: PersistedProjectKind;
  displayName: string;
  customName?: string | null;
  projectKey?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return PersistedProjectRecordSchema.parse({
    ...input,
    customName: input.customName ?? null,
    projectKey: input.projectKey ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

export function resolveProjectDisplayName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

export function createPersistedWorkspaceRecord(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceKind;
  displayName: string;
  title?: string | null;
  branch?: string | null;
  worktreeRoot?: string | null;
  baseBranch?: string | null;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
  cleanupPending?: PersistedWorkspaceCleanupPending | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  pinnedAt?: string | null;
}): PersistedWorkspaceRecord {
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    worktreeRoot: input.worktreeRoot ?? null,
    baseBranch: input.baseBranch ?? null,
    isPaseoOwnedWorktree: input.isPaseoOwnedWorktree ?? false,
    mainRepoRoot: input.mainRepoRoot ?? null,
    cleanupPending: input.cleanupPending ?? null,
    archivedAt: input.archivedAt ?? null,
    pinnedAt: input.pinnedAt ?? null,
  });
}

// The single workspace-name rule: the title always wins; otherwise fall back to
// the freshest available derived display name (a live branch snapshot when the
// caller has one, the persisted displayName otherwise).
export function resolveWorkspaceName(input: {
  title: string | null;
  derivedDisplayName: string;
}): string {
  return input.title ?? input.derivedDisplayName;
}

export function resolveWorkspaceDisplayName(record: PersistedWorkspaceRecord): string {
  return resolveWorkspaceName({ title: record.title, derivedDisplayName: record.displayName });
}
