import { describe, expect, it } from "vitest";
import { resolveFleetWorktreeBase } from "./run.js";

const head = "0123456789abcdef0123456789abcdef01234567";

describe("fleet worktree base", () => {
  it("uses the caller's exact commit for a branch-off fleet worktree", () => {
    expect(resolveFleetWorktreeBase({ newWorkspace: "worktree" }, "/repo", () => head)).toBe(head);
  });

  it("preserves an explicit base without reading the caller repository", () => {
    expect(
      resolveFleetWorktreeBase(
        { newWorkspace: "worktree", base: "paseo-runtime/main" },
        "/repo",
        () => {
          throw new Error("should not read Git");
        },
      ),
    ).toBe("paseo-runtime/main");
  });

  it("does not add a base for non-branch-off workspace operations", () => {
    expect(
      resolveFleetWorktreeBase(
        { newWorkspace: "worktree", worktreeMode: "checkout-branch", branch: "feature" },
        "/repo",
        () => {
          throw new Error("should not read Git");
        },
      ),
    ).toBeUndefined();
  });

  it("fails closed when the caller cwd does not resolve to a full Git commit", () => {
    try {
      resolveFleetWorktreeBase({ newWorkspace: "worktree" }, "/not-a-repo", () => "bad");
      throw new Error("expected base resolution to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "FLEET_WORKTREE_BASE_UNRESOLVED" });
    }
  });
});
