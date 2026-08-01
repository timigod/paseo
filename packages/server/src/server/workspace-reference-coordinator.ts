import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Serializes creation/reference mutations with cleanup-only directory removal.
 * The async-local marker makes nested registry writes re-entrant while a
 * higher-level worktree creation owns the reservation.
 */
export class WorkspaceReferenceCoordinator {
  private readonly ownership = new AsyncLocalStorage<symbol>();
  private readonly activeOwners = new Set<symbol>();
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const inheritedOwner = this.ownership.getStore();
    if (inheritedOwner && this.activeOwners.has(inheritedOwner)) {
      return operation();
    }

    const previous = this.tail.catch(() => undefined);
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const owner = Symbol("workspace-reference-owner");
    this.activeOwners.add(owner);
    try {
      return await this.ownership.run(owner, operation);
    } finally {
      this.activeOwners.delete(owner);
      release();
    }
  }
}

export const defaultWorkspaceReferenceCoordinator = new WorkspaceReferenceCoordinator();
