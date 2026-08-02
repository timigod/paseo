import { isRealpathInsideRoot } from "../utils/path.js";

export interface DestructiveMembershipScope {
  readonly agentIds?: readonly string[];
  readonly workspaceIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly paths?: readonly string[];
}

export interface DestructiveMembershipLease {
  extend(scope: DestructiveMembershipScope): Promise<void>;
  release(): void;
}

export interface MembershipMutationLease {
  release(): void;
}

export class DestructiveMembershipExcludedError extends Error {
  constructor(readonly whenUnfenced: Promise<void> = Promise.resolve()) {
    super("Target membership is currently fenced by a destructive lifecycle operation");
    this.name = "DestructiveMembershipExcludedError";
  }
}

interface NormalizedMembershipScope {
  readonly agentIds: Set<string>;
  readonly workspaceIds: Set<string>;
  readonly projectIds: Set<string>;
  readonly paths: Set<string>;
}

interface ActiveMembershipMutation {
  readonly scope: NormalizedMembershipScope;
  released: boolean;
}

interface ActiveDestructiveLease {
  scope: NormalizedMembershipScope;
  released: boolean;
}

function normalizeScope(scope: DestructiveMembershipScope): NormalizedMembershipScope {
  return {
    agentIds: new Set(scope.agentIds?.filter(Boolean) ?? []),
    workspaceIds: new Set(scope.workspaceIds?.filter(Boolean) ?? []),
    projectIds: new Set(scope.projectIds?.filter(Boolean) ?? []),
    paths: new Set(scope.paths?.filter(Boolean) ?? []),
  };
}

function mergeScope(
  current: NormalizedMembershipScope,
  extension: DestructiveMembershipScope,
): NormalizedMembershipScope {
  const next = normalizeScope(extension);
  return {
    agentIds: new Set([...current.agentIds, ...next.agentIds]),
    workspaceIds: new Set([...current.workspaceIds, ...next.workspaceIds]),
    projectIds: new Set([...current.projectIds, ...next.projectIds]),
    paths: new Set([...current.paths, ...next.paths]),
  };
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function pathsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (isRealpathInsideRoot(leftPath, rightPath) || isRealpathInsideRoot(rightPath, leftPath)) {
        return true;
      }
    }
  }
  return false;
}

function scopesOverlap(left: NormalizedMembershipScope, right: NormalizedMembershipScope): boolean {
  return (
    setsOverlap(left.agentIds, right.agentIds) ||
    setsOverlap(left.workspaceIds, right.workspaceIds) ||
    setsOverlap(left.projectIds, right.projectIds) ||
    pathsOverlap(left.paths, right.paths)
  );
}

/**
 * A daemon-local exclusion gate for membership-changing commits.
 *
 * Destructive leases are installed synchronously, then wait for already-started
 * overlapping membership changes to settle. New overlapping creates, attaches,
 * unarchives, and ownership changes fail closed until the destructive lease is
 * released. Destructive operations may overlap each other; the gate exists to
 * make their target membership stable, not to serialize idempotent teardown.
 */
export class DestructiveMembershipGate {
  private readonly membershipMutations = new Set<ActiveMembershipMutation>();
  private readonly destructiveLeases = new Set<ActiveDestructiveLease>();
  private readonly mutationSettledWaiters = new Set<() => void>();
  private readonly destructiveReleasedWaiters = new Set<() => void>();

  beginMembershipMutation(scope: DestructiveMembershipScope): MembershipMutationLease {
    const normalizedScope = normalizeScope(scope);
    if (this.hasOverlappingDestructiveLease(normalizedScope)) {
      throw new DestructiveMembershipExcludedError(
        this.waitForOverlappingDestructiveLeases(normalizedScope),
      );
    }

    const mutation: ActiveMembershipMutation = { scope: normalizedScope, released: false };
    this.membershipMutations.add(mutation);
    return {
      release: () => {
        if (mutation.released) return;
        mutation.released = true;
        this.membershipMutations.delete(mutation);
        for (const notify of this.mutationSettledWaiters) notify();
      },
    };
  }

  async acquireDestructive(scope: DestructiveMembershipScope): Promise<DestructiveMembershipLease> {
    const active: ActiveDestructiveLease = {
      scope: normalizeScope(scope),
      released: false,
    };
    this.destructiveLeases.add(active);
    await this.waitForOverlappingMutations(active);

    return {
      extend: async (extension) => {
        if (active.released) {
          throw new Error("Cannot extend a released destructive membership lease");
        }
        active.scope = mergeScope(active.scope, extension);
        await this.waitForOverlappingMutations(active);
      },
      release: () => {
        if (active.released) return;
        active.released = true;
        this.destructiveLeases.delete(active);
        for (const notify of this.destructiveReleasedWaiters) notify();
      },
    };
  }

  private async waitForOverlappingMutations(lease: ActiveDestructiveLease): Promise<void> {
    while (
      Array.from(this.membershipMutations).some(
        (mutation) => !mutation.released && scopesOverlap(lease.scope, mutation.scope),
      )
    ) {
      await new Promise<void>((resolve) => {
        const notify = () => {
          this.mutationSettledWaiters.delete(notify);
          resolve();
        };
        this.mutationSettledWaiters.add(notify);
      });
    }
  }

  private hasOverlappingDestructiveLease(scope: NormalizedMembershipScope): boolean {
    return Array.from(this.destructiveLeases).some(
      (lease) => !lease.released && scopesOverlap(lease.scope, scope),
    );
  }

  private async waitForOverlappingDestructiveLeases(
    scope: NormalizedMembershipScope,
  ): Promise<void> {
    while (this.hasOverlappingDestructiveLease(scope)) {
      await new Promise<void>((resolve) => {
        const notify = () => {
          this.destructiveReleasedWaiters.delete(notify);
          resolve();
        };
        this.destructiveReleasedWaiters.add(notify);
      });
    }
  }
}
