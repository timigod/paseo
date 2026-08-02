import { describe, expect, test } from "vitest";

import {
  assertDestructiveActionAuthorized,
  createAgentDestructiveCaller,
  createCoordinatorDestructiveCaller,
  createUncertainDestructiveCaller,
  DestructiveActionAuthorizationError,
  revokeDestructiveCaller,
} from "./destructive-action-authority.js";

interface FakeAgent {
  id: string;
  workspaceId?: string;
  cwd?: string;
  containmentPaths?: readonly string[];
}

class FakeLiveAgentAuthority {
  readonly agents = new Map<string, FakeAgent>();
  readonly incarnations = new Map<string, string>();

  getAgent(agentId: string): FakeAgent | null {
    return this.agents.get(agentId) ?? null;
  }

  isCurrentAgentIncarnation(agentId: string, incarnation: string): boolean {
    return this.incarnations.get(agentId) === incarnation;
  }
}

function liveAuthority() {
  const authority = new FakeLiveAgentAuthority();
  authority.agents.set("agent-a", { id: "agent-a", workspaceId: "workspace-a" });
  authority.agents.set("agent-b", { id: "agent-b", workspaceId: "workspace-b" });
  authority.incarnations.set("agent-a", "incarnation-a");
  authority.incarnations.set("agent-b", "incarnation-b");
  return authority;
}

describe("destructive action authority", () => {
  test("rejects every self-target shape before the destructive action runs", () => {
    const authority = liveAuthority();
    const caller = createAgentDestructiveCaller({
      agentId: "agent-a",
      incarnation: "incarnation-a",
    });

    for (const action of ["agent.archive", "agent.delete", "agent.kill", "agent.finish"] as const) {
      expect(() =>
        assertDestructiveActionAuthorized(authority, caller, {
          action,
          targetAgentIds: ["agent-a"],
          targetWorkspaceIds: [],
          hasLiveTarget: true,
        }),
      ).toThrowError(DestructiveActionAuthorizationError);
    }

    for (const action of ["workspace.archive", "worktree.archive"] as const) {
      expect(() =>
        assertDestructiveActionAuthorized(authority, caller, {
          action,
          targetAgentIds: [],
          targetWorkspaceIds: ["workspace-a"],
          hasLiveTarget: true,
        }),
      ).toThrowError(DestructiveActionAuthorizationError);
    }
  });

  test("allows one current agent to archive another agent or workspace", () => {
    const authority = liveAuthority();
    const caller = createAgentDestructiveCaller({
      agentId: "agent-a",
      incarnation: "incarnation-a",
    });

    expect(() =>
      assertDestructiveActionAuthorized(authority, caller, {
        action: "agent.archive",
        targetAgentIds: ["agent-b"],
        targetWorkspaceIds: [],
        hasLiveTarget: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertDestructiveActionAuthorized(authority, caller, {
        action: "workspace.archive",
        targetAgentIds: ["agent-b"],
        targetWorkspaceIds: ["workspace-b"],
        hasLiveTarget: true,
      }),
    ).not.toThrow();
  });

  test("rejects stale, replayed, and agent-mismatched incarnations", () => {
    const authority = liveAuthority();
    const original = createAgentDestructiveCaller({
      agentId: "agent-a",
      incarnation: "incarnation-a",
    });
    const mismatched = createAgentDestructiveCaller({
      agentId: "agent-b",
      incarnation: "incarnation-a",
    });
    authority.incarnations.set("agent-a", "incarnation-after-restart");

    for (const caller of [original, mismatched]) {
      expect(() =>
        assertDestructiveActionAuthorized(authority, caller, {
          action: "agent.archive",
          targetAgentIds: ["agent-b"],
          targetWorkspaceIds: [],
          hasLiveTarget: true,
        }),
      ).toThrowError(DestructiveActionAuthorizationError);
    }
  });

  test("fails closed for missing identity for both live and stored-only targets", () => {
    const authority = liveAuthority();
    const caller = createUncertainDestructiveCaller("legacy caller omitted live identity");

    expect(() =>
      assertDestructiveActionAuthorized(authority, caller, {
        action: "agent.delete",
        targetAgentIds: ["agent-a"],
        targetWorkspaceIds: [],
        hasLiveTarget: true,
      }),
    ).toThrowError(DestructiveActionAuthorizationError);
    expect(() =>
      assertDestructiveActionAuthorized(authority, caller, {
        action: "agent.delete",
        targetAgentIds: ["archived-agent"],
        targetWorkspaceIds: [],
        hasLiveTarget: false,
      }),
    ).toThrowError(DestructiveActionAuthorizationError);
  });

  test("accepts only coordinator authority minted in process", () => {
    const authority = liveAuthority();
    const coordinator = createCoordinatorDestructiveCaller();
    const forged = { kind: "coordinator" } as typeof coordinator;
    const action = {
      action: "workspace.archive" as const,
      targetAgentIds: ["agent-a"],
      targetWorkspaceIds: ["workspace-a"],
      hasLiveTarget: true,
    };

    expect(() => assertDestructiveActionAuthorized(authority, coordinator, action)).not.toThrow();
    expect(() => assertDestructiveActionAuthorized(authority, forged, action)).toThrowError(
      DestructiveActionAuthorizationError,
    );
  });

  test("blocks a target containing the caller cwd or its canonical checkout root", () => {
    const authority = liveAuthority();
    authority.agents.set("agent-a", {
      id: "agent-a",
      cwd: "/managed/repo/packages/server",
      containmentPaths: ["/managed/repo"],
    });
    const caller = createAgentDestructiveCaller({
      agentId: "agent-a",
      incarnation: "incarnation-a",
    });

    for (const targetPaths of [["/managed/repo"], ["/managed/repo/packages"]]) {
      expect(() =>
        assertDestructiveActionAuthorized(authority, caller, {
          action: "workspace.archive",
          targetAgentIds: [],
          targetWorkspaceIds: ["legacy-workspace-without-agent-owner"],
          targetPaths,
          hasLiveTarget: true,
        }),
      ).toThrowError(DestructiveActionAuthorizationError);
    }
  });

  test("allows an agent to target a different checkout", () => {
    const authority = liveAuthority();
    authority.agents.set("agent-a", {
      id: "agent-a",
      cwd: "/managed/repo-a/packages/server",
      containmentPaths: ["/managed/repo-a"],
    });
    const caller = createAgentDestructiveCaller({
      agentId: "agent-a",
      incarnation: "incarnation-a",
    });

    expect(() =>
      assertDestructiveActionAuthorized(authority, caller, {
        action: "workspace.archive",
        targetAgentIds: [],
        targetWorkspaceIds: ["workspace-b"],
        targetPaths: ["/managed/repo-b"],
        hasLiveTarget: true,
      }),
    ).not.toThrow();
  });

  test("revokes a captured caller before a deferred destructive mutation resumes", async () => {
    const authority = liveAuthority();
    const caller = createCoordinatorDestructiveCaller();
    let releaseLookup = () => {};
    const lookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let mutated = false;

    const operation = (async () => {
      await lookup;
      assertDestructiveActionAuthorized(authority, caller, {
        action: "workspace.archive",
        targetAgentIds: ["agent-b"],
        targetWorkspaceIds: ["workspace-b"],
        hasLiveTarget: true,
      });
      mutated = true;
    })();

    revokeDestructiveCaller(caller);
    releaseLookup();

    await expect(operation).rejects.toThrowError(DestructiveActionAuthorizationError);
    expect(mutated).toBe(false);
  });

  test("rejects an aborted request even while its captured caller remains active", () => {
    const authority = liveAuthority();
    const caller = createCoordinatorDestructiveCaller();
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      assertDestructiveActionAuthorized(
        authority,
        caller,
        {
          action: "agent.archive",
          targetAgentIds: ["agent-b"],
          targetWorkspaceIds: ["workspace-b"],
          hasLiveTarget: true,
        },
        controller.signal,
      ),
    ).toThrowError(DestructiveActionAuthorizationError);
  });
});
