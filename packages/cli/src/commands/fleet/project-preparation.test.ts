import { describe, expect, it, vi } from "vitest";
import type { FleetHost } from "./topology.js";
import { ensureFleetTargetProject } from "./project-preparation.js";

const macbook: FleetHost = {
  id: "macbook",
  name: "MacBook",
  endpoint: "macbook:6767",
  codeRoot: "/Users/source/Code",
  hostnamePrefixes: ["macbook"],
  capacity: 10,
};
const imac: FleetHost = {
  id: "imac",
  name: "iMac",
  endpoint: "imac:6767",
  codeRoot: "/Users/target/Code",
  hostnamePrefixes: ["imac"],
  capacity: 10,
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn(async () => ({ projects: [] })),
    addProject: vi.fn(async () => ({
      project: null,
      error: "Directory not found",
      errorCode: "directory_not_found" as const,
    })),
    cloneGithubProject: vi.fn(async () => ({
      checkoutPath: "/Users/target/Code/paseo",
      project: { projectRootPath: "/Users/target/Code/paseo" },
      error: null,
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("fleet target project preparation", () => {
  it("clones a missing canonical checkout and preserves the source subdirectory", async () => {
    const target = client();
    await expect(
      ensureFleetTargetProject({
        sourceCwd: "/Users/source/Code/paseo/packages/cli",
        sourceHost: macbook,
        targetHost: imac,
        readSource: () => ({
          root: "/Users/source/Code/paseo",
          origin: "https://github.com/getpaseo/paseo.git",
        }),
        connect: async () => target,
      }),
    ).resolves.toEqual({
      cwd: "/Users/target/Code/paseo/packages/cli",
      prepared: "cloned",
    });
    expect(target.cloneGithubProject).toHaveBeenCalledWith({
      repo: "https://github.com/getpaseo/paseo.git",
      targetDirectory: "/Users/target/Code",
    });
  });

  it("registers an existing unregistered canonical checkout without cloning", async () => {
    const target = client({
      addProject: vi.fn(async () => ({
        project: { projectRootPath: "/Users/target/Code/paseo" },
        error: null,
        errorCode: null,
      })),
    });
    await expect(
      ensureFleetTargetProject({
        sourceCwd: "/Users/source/Code/paseo",
        sourceHost: macbook,
        targetHost: imac,
        readSource: () => ({
          root: "/Users/source/Code/paseo",
          origin: "git@github.com:getpaseo/paseo.git",
        }),
        connect: async () => target,
      }),
    ).resolves.toMatchObject({ prepared: "registered" });
    expect(target.cloneGithubProject).not.toHaveBeenCalled();
  });

  it("fails without cloning over an existing target whose registration is broken", async () => {
    const target = client({
      addProject: vi.fn(async () => ({
        project: null,
        error: "spawn git ENOENT",
        errorCode: null,
      })),
    });
    await expect(
      ensureFleetTargetProject({
        sourceCwd: "/Users/source/Code/paseo",
        sourceHost: macbook,
        targetHost: imac,
        readSource: () => ({
          root: "/Users/source/Code/paseo",
          origin: "https://github.com/getpaseo/paseo.git",
        }),
        connect: async () => target,
      }),
    ).rejects.toMatchObject({ code: "FLEET_PROJECT_PREP_FAILED" });
    expect(target.cloneGithubProject).not.toHaveBeenCalled();
  });
});
