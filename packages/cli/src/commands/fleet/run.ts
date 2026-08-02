import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { CommandError } from "../../output/index.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import type { FleetDefaults } from "./topology.js";

export interface FleetPromptOptions {
  prompt?: string;
  promptFile?: string;
}

export async function resolveFleetRunPrompt(
  positionalPrompt: string | undefined,
  options: FleetPromptOptions,
): Promise<string> {
  const sources = [positionalPrompt, options.prompt, options.promptFile].filter(
    (value) => value !== undefined,
  );
  if (sources.length > 1) {
    throw {
      code: "CONFLICTING_PROMPT_INPUT",
      message: "Provide exactly one of prompt argument, --prompt, or --prompt-file",
    } satisfies CommandError;
  }

  if (options.promptFile !== undefined) {
    let contents: Buffer;
    try {
      contents = await readFile(path.resolve(options.promptFile));
    } catch (error) {
      throw {
        code: "PROMPT_FILE_READ_ERROR",
        message: `Failed to read prompt file ${options.promptFile}`,
        details: error instanceof Error ? error.message : String(error),
      } satisfies CommandError;
    }
    try {
      const prompt = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      if (!prompt.trim()) {
        throw { code: "EMPTY_PROMPT_FILE", message: "Prompt file is empty" } satisfies CommandError;
      }
      return prompt;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EMPTY_PROMPT_FILE"
      ) {
        throw error;
      }
      throw {
        code: "PROMPT_FILE_DECODE_ERROR",
        message: `Prompt file ${options.promptFile} is not valid UTF-8`,
      } satisfies CommandError;
    }
  }

  const prompt = positionalPrompt ?? options.prompt;
  if (prompt === undefined || !prompt.trim()) {
    throw { code: "MISSING_PROMPT", message: "A prompt is required" } satisfies CommandError;
  }
  return prompt;
}

export function resolveFleetProviderModelOptions(
  options: { provider?: string; model?: string },
  defaults: FleetDefaults,
) {
  const provider = options.provider ?? defaults.provider;
  const model = options.model ?? (options.provider === undefined ? defaults.model : undefined);
  const resolved = resolveProviderAndModel({ provider, model });
  return {
    provider,
    model,
    effectiveProvider: resolved.provider,
    effectiveModel: resolved.model,
  };
}

function readGitHead(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveFleetWorktreeBase(
  options: { newWorkspace?: string; worktree?: string; worktreeMode?: string; base?: string },
  cwd: string,
  readHead: (cwd: string) => string = readGitHead,
  callerCanReadCwd = true,
): string | undefined {
  const newWorkspace = options.newWorkspace ?? (options.worktree ? "worktree" : undefined);
  const branchOff =
    newWorkspace === "worktree" && (options.worktreeMode ?? "branch-off") === "branch-off";
  if (!branchOff || options.base) return options.base;
  // A fleet caller must not inspect a target host's absolute path on the
  // caller machine. With no explicit base, the owning daemon resolves its
  // own checkout default just as the local workspace flow does.
  if (!callerCanReadCwd) return undefined;
  try {
    const base = readHead(cwd).trim();
    if (!/^[0-9a-f]{40}$/u.test(base)) throw new Error("not a full commit id");
    return base;
  } catch {
    throw {
      code: "FLEET_WORKTREE_BASE_UNRESOLVED",
      message: "Cannot resolve the caller's Git commit for fleet worktree creation",
      details: "Run from a Git checkout or pass --base <ref> explicitly.",
    } satisfies CommandError;
  }
}
