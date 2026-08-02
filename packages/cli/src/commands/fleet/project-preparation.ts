import { execFileSync } from "node:child_process";
import path from "node:path";
import type { CommandError } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import type { FleetHost } from "./topology.js";
import { translateFleetCwd } from "./topology.js";

interface SourceCheckoutIdentity {
  root: string;
  origin: string;
}

interface FleetProjectClient {
  listProjects(): Promise<{
    projects: Array<{ projectRootPath: string }>;
  }>;
  addProject(cwd: string): Promise<{
    project: { projectRootPath: string } | null;
    error: string | null;
    errorCode?: "directory_not_found" | null;
  }>;
  cloneGithubProject(input: { repo: string; targetDirectory: string }): Promise<{
    checkoutPath: string | null;
    project: { projectRootPath: string } | null;
    error: string | null;
  }>;
  close(): Promise<void>;
}

function commandError(code: string, message: string, details?: string): CommandError {
  return { code, message, ...(details ? { details } : {}) };
}

function readSourceCheckoutIdentity(cwd: string): SourceCheckoutIdentity {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!root || !origin) throw new Error("missing repository root or origin");
    return { root: path.resolve(root), origin };
  } catch (error) {
    throw commandError(
      "FLEET_SOURCE_PROJECT_UNRESOLVED",
      `Cannot resolve the source repository for ${cwd}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function repositoryNameFromOrigin(origin: string): string | null {
  const withoutQuery = origin.trim().split(/[?#]/u, 1)[0]?.replace(/\/+$/u, "") ?? "";
  const leaf = withoutQuery
    .split(/[/:]/u)
    .at(-1)
    ?.replace(/\.git$/u, "")
    .trim();
  return leaf || null;
}

export async function ensureFleetTargetProject(input: {
  sourceCwd: string;
  sourceHost: FleetHost;
  targetHost: FleetHost;
  readSource?: (cwd: string) => SourceCheckoutIdentity;
  connect?: (host: string) => Promise<FleetProjectClient>;
}): Promise<{ cwd: string; prepared: "existing" | "registered" | "cloned" }> {
  const readSource = input.readSource ?? readSourceCheckoutIdentity;
  const source = readSource(input.sourceCwd);
  const targetRoot = translateFleetCwd(source.root, input.sourceHost, input.targetHost);
  const relativeCwd = path.relative(source.root, path.resolve(input.sourceCwd));
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`)) {
    throw commandError(
      "FLEET_SOURCE_PROJECT_UNRESOLVED",
      `${input.sourceCwd} is outside its resolved repository root ${source.root}`,
    );
  }
  const targetCwd = path.join(targetRoot, relativeCwd);
  const connect =
    input.connect ?? ((host) => connectToDaemon({ host }) as Promise<FleetProjectClient>);
  const client = await connect(input.targetHost.endpoint);

  try {
    const projects = await client.listProjects();
    if (projects.projects.some((project) => samePath(project.projectRootPath, targetRoot))) {
      return { cwd: targetCwd, prepared: "existing" };
    }

    const added = await client.addProject(targetRoot);
    if (added.project && samePath(added.project.projectRootPath, targetRoot)) {
      return { cwd: targetCwd, prepared: "registered" };
    }
    if (added.errorCode !== "directory_not_found") {
      throw commandError(
        "FLEET_PROJECT_PREP_FAILED",
        `Cannot register the target checkout ${targetRoot} on ${input.targetHost.id}`,
        added.error ?? "The daemon did not return a project.",
      );
    }

    const repositoryName = repositoryNameFromOrigin(source.origin);
    if (!repositoryName || repositoryName !== path.basename(targetRoot)) {
      throw commandError(
        "FLEET_PROJECT_PREP_FAILED",
        `Cannot safely clone ${source.origin} into ${targetRoot}`,
        "The canonical checkout directory must match the repository name; add an explicit host checkout mapping.",
      );
    }

    const cloned = await client.cloneGithubProject({
      repo: source.origin,
      targetDirectory: path.dirname(targetRoot),
    });
    if (
      cloned.error ||
      !cloned.checkoutPath ||
      !cloned.project ||
      !samePath(cloned.checkoutPath, targetRoot) ||
      !samePath(cloned.project.projectRootPath, targetRoot)
    ) {
      throw commandError(
        "FLEET_PROJECT_PREP_FAILED",
        `Cannot prepare ${targetRoot} on ${input.targetHost.id}`,
        cloned.error ??
          `Clone resolved to ${cloned.checkoutPath ?? "no checkout"}; expected ${targetRoot}.`,
      );
    }
    return { cwd: targetCwd, prepared: "cloned" };
  } finally {
    await client.close().catch(() => undefined);
  }
}
