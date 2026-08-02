import { resolve } from "node:path";
import type { Logger } from "pino";

import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "./workspace-git-service.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

interface ServiceRouteWatchTarget {
  workspaceIds: Set<string>;
  unsubscribe: () => void;
}

interface ServiceRouteWorkspaceState {
  cwd: string;
  branchName: string | null;
}

/**
 * One daemon-owned Git observer lane for running service routes. Client sessions own UI
 * subscriptions only; short-lived CLI sessions must never become service-route observers.
 */
export class ServiceRouteWorkspaceObserver {
  private readonly targets = new Map<string, ServiceRouteWatchTarget>();
  private readonly workspaces = new Map<string, ServiceRouteWorkspaceState>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      workspaceGitService: Pick<WorkspaceGitService, "peekSnapshot" | "registerWorkspace">;
      workspaceRegistry: Pick<WorkspaceRegistry, "get">;
      runtimeStore: WorkspaceScriptRuntimeStore;
      onBranchChanged: (
        workspaceId: string,
        oldBranch: string | null,
        newBranch: string | null,
      ) => void;
      logger: Logger;
    },
  ) {}

  syncWorkspaceIds(workspaceIds: Iterable<string>): Promise<void> {
    const uniqueWorkspaceIds = Array.from(new Set(workspaceIds));
    const run = this.queue.then(async () => {
      for (const workspaceId of uniqueWorkspaceIds) {
        await this.syncWorkspaceId(workspaceId);
      }
    });
    this.queue = run.catch((error) => {
      this.options.logger.warn(
        { err: error, workspaceIds: uniqueWorkspaceIds },
        "Failed to synchronize service-route workspace observers",
      );
    });
    return run;
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      target.unsubscribe();
    }
    this.targets.clear();
    this.workspaces.clear();
  }

  private async syncWorkspaceId(workspaceId: string): Promise<void> {
    const hasRunningService = this.options.runtimeStore
      .listForWorkspace(workspaceId)
      .some((entry) => entry.type === "service" && entry.lifecycle === "running");
    if (!hasRunningService) {
      this.removeWorkspace(workspaceId);
      return;
    }

    const workspace = await this.options.workspaceRegistry.get(workspaceId);
    const stillHasRunningService = this.options.runtimeStore
      .listForWorkspace(workspaceId)
      .some((entry) => entry.type === "service" && entry.lifecycle === "running");
    if (!workspace || workspace.archivedAt || !stillHasRunningService) {
      this.removeWorkspace(workspaceId);
      return;
    }

    const cwd = resolve(workspace.cwd);
    const current = this.workspaces.get(workspaceId);
    if (current?.cwd === cwd) {
      return;
    }
    this.removeWorkspace(workspaceId);

    let target = this.targets.get(cwd);
    if (!target) {
      const workspaceIdsForTarget = new Set<string>();
      const subscription = this.options.workspaceGitService.registerWorkspace(
        { cwd },
        (snapshot) => this.handleSnapshot(cwd, snapshot),
      );
      target = {
        workspaceIds: workspaceIdsForTarget,
        unsubscribe: subscription.unsubscribe,
      };
      this.targets.set(cwd, target);
    }
    target.workspaceIds.add(workspaceId);
    this.workspaces.set(workspaceId, {
      cwd,
      branchName:
        this.options.workspaceGitService.peekSnapshot(cwd)?.git.currentBranch ??
        workspace.branch ??
        null,
    });
  }

  private handleSnapshot(cwd: string, snapshot: WorkspaceGitRuntimeSnapshot): void {
    const target = this.targets.get(resolve(cwd));
    if (!target) return;
    const branchName = snapshot.git.currentBranch ?? null;
    for (const workspaceId of target.workspaceIds) {
      const state = this.workspaces.get(workspaceId);
      if (!state || state.branchName === branchName) continue;
      const previousBranchName = state.branchName;
      state.branchName = branchName;
      this.options.onBranchChanged(workspaceId, previousBranchName, branchName);
    }
  }

  private removeWorkspace(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    this.workspaces.delete(workspaceId);
    const target = this.targets.get(state.cwd);
    target?.workspaceIds.delete(workspaceId);
    if (target?.workspaceIds.size === 0) {
      target.unsubscribe();
      this.targets.delete(state.cwd);
    }
  }
}
