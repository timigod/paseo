import { describe, expect, test } from "vitest";

import {
  DestructiveMembershipExcludedError,
  DestructiveMembershipGate,
} from "./destructive-membership-gate.js";

describe("DestructiveMembershipGate", () => {
  test("waits for an overlapping membership commit and then rejects late membership", async () => {
    const gate = new DestructiveMembershipGate();
    const mutation = gate.beginMembershipMutation({ workspaceIds: ["workspace-one"] });
    let acquired = false;
    const leasePromise = gate
      .acquireDestructive({ workspaceIds: ["workspace-one"] })
      .then((lease) => {
        acquired = true;
        return lease;
      });

    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(() => gate.beginMembershipMutation({ workspaceIds: ["workspace-one"] })).toThrow(
      DestructiveMembershipExcludedError,
    );

    mutation.release();
    const lease = await leasePromise;
    expect(acquired).toBe(true);
    expect(() => gate.beginMembershipMutation({ workspaceIds: ["workspace-one"] })).toThrow(
      DestructiveMembershipExcludedError,
    );

    lease.release();
    expect(() => gate.beginMembershipMutation({ workspaceIds: ["workspace-one"] })).not.toThrow();
  });

  test("matches descendant paths while leaving unrelated membership available", async () => {
    const gate = new DestructiveMembershipGate();
    const lease = await gate.acquireDestructive({ paths: ["/tmp/project/worktree"] });

    expect(() =>
      gate.beginMembershipMutation({ paths: ["/tmp/project/worktree/packages/server"] }),
    ).toThrow(DestructiveMembershipExcludedError);
    const unrelated = gate.beginMembershipMutation({
      paths: ["/tmp/another-worktree"],
      workspaceIds: ["workspace-two"],
    });
    unrelated.release();
    lease.release();
  });

  test("extension closes newly discovered agent ancestry before teardown continues", async () => {
    const gate = new DestructiveMembershipGate();
    const inFlightChild = gate.beginMembershipMutation({ agentIds: ["child", "parent"] });
    const lease = await gate.acquireDestructive({ workspaceIds: ["workspace-one"] });
    let extended = false;
    const extension = lease.extend({ agentIds: ["parent"] }).then(() => {
      extended = true;
      return undefined;
    });

    await Promise.resolve();
    expect(extended).toBe(false);
    expect(() =>
      gate.beginMembershipMutation({ agentIds: ["grandchild", "child", "parent"] }),
    ).toThrow(DestructiveMembershipExcludedError);
    inFlightChild.release();
    await extension;
    expect(extended).toBe(true);
    lease.release();
  });
});
