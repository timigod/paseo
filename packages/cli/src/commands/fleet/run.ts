import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Command } from "commander";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import {
  addRunOptions,
  runRunCommand,
  type AgentRunOptions,
  type AgentRunResult,
} from "../agent/run.js";
import { collectFleetStatus } from "./status.js";
import { selectFleetHost, type FleetRouteReason } from "./routing.js";
import {
  FLEET_DEFAULT_MODEL,
  FLEET_DEFAULT_PROVIDER,
  FLEET_DEFAULT_THINKING,
  findFleetHost,
  findFleetHostForCwd,
  findFleetHostForHostname,
} from "./topology.js";

export interface FleetRunOptions extends AgentRunOptions {
  host?: string;
}

export interface FleetRunResult extends AgentRunResult {
  fleetHost: string;
  fleetEndpoint: string;
  routeReason: FleetRouteReason;
  effectiveModel: string;
  effectiveThinking: string;
}

const fleetRunSchema: OutputSchema<FleetRunResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "HOST", field: "fleetHost", width: 10 },
    { header: "ROUTE", field: "routeReason", width: 14 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "MODEL", field: "effectiveModel", width: 24 },
    { header: "CWD", field: "cwd", width: 30 },
  ],
};

export function addFleetRunOptions(command: Command): Command {
  return addRunOptions(command)
    .option(
      "--host <host>",
      "Pin a configured fleet host (macbook or imac); fleet run otherwise selects automatically",
    )
    .description("Dispatch an agent to the healthy eligible Plexer fleet host");
}

function toFleetError(code: string, message: string, details?: string): CommandError {
  return { code, message, ...(details ? { details } : {}) };
}

function hasAmbientWorkspaceContext(options: FleetRunOptions): boolean {
  return Boolean(options.workspace || process.env.PASEO_WORKSPACE_ID || process.env.PASEO_AGENT_ID);
}

function createsBranchOffWorktree(options: FleetRunOptions): boolean {
  const newWorkspace = options.newWorkspace ?? (options.worktree ? "worktree" : undefined);
  return newWorkspace === "worktree" && (options.worktreeMode ?? "branch-off") === "branch-off";
}

function readGitHead(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveFleetWorktreeBase(
  options: FleetRunOptions,
  cwd: string,
  readHead: (cwd: string) => string = readGitHead,
): string | undefined {
  if (!createsBranchOffWorktree(options) || options.base) return options.base;

  try {
    const base = readHead(cwd).trim();
    if (!/^[0-9a-f]{40}$/u.test(base)) {
      throw new Error("Git did not return a full commit id");
    }
    return base;
  } catch {
    throw toFleetError(
      "FLEET_WORKTREE_BASE_UNRESOLVED",
      "Cannot resolve the caller's Git commit for fleet worktree creation",
      "Run from a Git checkout or pass --base <ref> explicitly.",
    );
  }
}

export async function runFleetRunCommand(
  prompt: string,
  options: FleetRunOptions,
  command: Command,
): Promise<SingleResult<FleetRunResult>> {
  const requestedHost = options.host?.trim();
  const pinnedHost = requestedHost ? findFleetHost(requestedHost) : null;
  if (requestedHost && !pinnedHost) {
    throw toFleetError(
      "INVALID_FLEET_HOST",
      `Unknown fleet host: ${requestedHost}`,
      "Use --host macbook or --host imac.",
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const sourceHost = findFleetHostForCwd(cwd);
  const localHost = findFleetHostForHostname(os.hostname());
  const requiresLocalContext = hasAmbientWorkspaceContext(options);
  if (requiresLocalContext && !localHost) {
    throw toFleetError(
      "FLEET_LOCAL_HOST_UNKNOWN",
      "Cannot route an ambient agent or workspace context from an unknown host",
      "Pass an explicit --cwd in a configured code root or run from a configured fleet host.",
    );
  }

  const statuses = await collectFleetStatus();
  const observations = statuses.flatMap((status) => {
    const host = findFleetHost(status.id);
    return host ? [{ ...status, host }] : [];
  });
  let plan;
  try {
    plan = selectFleetHost({
      observations,
      cwd,
      sourceHost,
      localHost,
      pinnedHost,
      requiresLocalContext,
    });
  } catch (error) {
    throw toFleetError(
      "FLEET_NO_ELIGIBLE_HOST",
      error instanceof Error ? error.message : String(error),
      "Run paseo fleet doctor for host-level diagnostics.",
    );
  }

  const effectiveProvider = options.provider ?? FLEET_DEFAULT_PROVIDER;
  const effectiveModel = options.model ?? FLEET_DEFAULT_MODEL;
  const effectiveThinking = options.thinking ?? FLEET_DEFAULT_THINKING;
  const effectiveBase = resolveFleetWorktreeBase(options, cwd);
  const result = await runRunCommand(
    prompt,
    {
      ...options,
      host: plan.host.endpoint,
      cwd: plan.cwd,
      provider: effectiveProvider,
      model: effectiveModel,
      thinking: effectiveThinking,
      base: effectiveBase,
    },
    command,
  );

  return {
    type: "single",
    data: {
      ...result.data,
      fleetHost: plan.host.id,
      fleetEndpoint: plan.host.endpoint,
      routeReason: plan.reason,
      effectiveModel,
      effectiveThinking,
    },
    schema: fleetRunSchema,
  };
}
