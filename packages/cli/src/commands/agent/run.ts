import { Command, Option } from "commander";
import { getStructuredAgentResponse, StructuredAgentResponseError } from "@getpaseo/server";
import type { AgentSnapshotPayload, WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lookup } from "mime-types";
import { parseDuration } from "../../utils/duration.js";
import { collectMultiple } from "../../utils/command-options.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { buildWorkspaceSource } from "../workspace/create.js";
import { parseAgentRunIntent, type AgentRunIntent } from "./run-intent.js";
import { DaemonRpcError } from "@getpaseo/client/internal/daemon-client";

export { resolveProviderAndModel } from "../../utils/provider-model.js";
export { type AgentRunIntent } from "./run-intent.js";

export function addRunOptions(cmd: Command, options: { optionalPrompt?: boolean } = {}): Command {
  return (
    cmd
      .description("Create and start an agent with a task")
      .argument(options.optionalPrompt ? "[prompt]" : "<prompt>", "The task/prompt for the agent")
      .option("-d, --background", "Run in background")
      // COMPAT(detachRunFlag): --detach used to mean background execution, not
      // ownership transfer. Added in v0.2.0; remove after 2027-01-17.
      .addOption(new Option("--detach", "Legacy alias for --background").hideHelp())
      .option("--title <title>", "Assign a title to the agent")
      .option("--idempotency-key <key>", "Reuse the original agent when retrying a create")
      .addOption(new Option("--name <name>", "Hidden alias for --title").hideHelp())
      .option(
        "--provider <provider>",
        "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
      )
      .option(
        "--model <model>",
        "Model to use (e.g., claude-sonnet-4-20250514, claude-3-5-haiku-20241022)",
      )
      .option("--thinking <id>", "Thinking option ID to use for this run")
      .option("--mode <mode>", "Provider-specific mode (e.g., plan, default, bypass)")
      .option("--new-workspace <local|worktree>", "Create a separate local or worktree workspace")
      .addOption(new Option("--worktree <name>", "Legacy workspace isolation alias").hideHelp())
      .option(
        "--worktree-mode <mode>",
        "Worktree mode: branch-off, checkout-branch, or checkout-pr",
      )
      .option("--worktree-slug <slug>", "Managed worktree path slug")
      .option("--new-branch <name>", "New branch name for branch-off mode")
      .option("--base <ref>", "Base ref for branch-off mode")
      .option("--branch <name>", "Existing branch for checkout-branch mode")
      .option("--pr-number <n>", "Pull request or change request number for checkout-pr mode")
      .option("--forge <forge>", "Forge for checkout-pr mode")
      .option(
        "--workspace <id>",
        "Run in an existing workspace (defaults to the caller workspace when agent-scoped)",
      )
      .option(
        "--image <path>",
        "Attach image(s) to the initial prompt (can be used multiple times)",
        collectMultiple,
        [],
      )
      .option("--cwd <path>", "Working directory (default: current)")
      .option(
        "--env <key=value>",
        "Set environment variable(s) for the agent process (can be used multiple times)",
        collectMultiple,
        [],
      )
      .option(
        "--label <key=value>",
        "Add label(s) to the agent (can be used multiple times)",
        collectMultiple,
        [],
      )
      .option(
        "--wait-timeout <duration>",
        "Maximum time to wait for agent to finish (e.g., 30s, 5m, 1h). Default: no limit",
      )
      .option(
        "--output-schema <schema>",
        "Output JSON matching the provided schema file path or inline JSON schema",
      )
  );
}

/** Result type for agent run command */
export interface AgentRunResult {
  agentId: string;
  status: "created" | "running" | "completed" | "timeout" | "permission" | "error";
  provider: string;
  cwd: string;
  title: string | null;
}

/** Schema for agent run output */
export const agentRunSchema: OutputSchema<AgentRunResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "CWD", field: "cwd", width: 30 },
    { header: "TITLE", field: "title", width: 20 },
  ],
};

export interface AgentRunOptions extends CommandOptions {
  background?: boolean;
  detach?: boolean;
  title?: string;
  idempotencyKey?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  newWorkspace?: string;
  worktree?: string;
  worktreeMode?: string;
  worktreeSlug?: string;
  newBranch?: string;
  base?: string;
  branch?: string;
  prNumber?: string;
  forge?: string;
  workspace?: string;
  image?: string[];
  cwd?: string;
  env?: string[];
  label?: string[];
  waitTimeout?: string;
  outputSchema?: string;
}

function resolveNewWorkspaceKind(options: AgentRunOptions): string | undefined {
  return options.newWorkspace ?? (options.worktree ? "worktree" : undefined);
}

function buildRunWorkspaceSource(options: AgentRunOptions, cwd: string) {
  const newWorkspace = resolveNewWorkspaceKind(options) ?? "local";
  return buildWorkspaceSource({
    isolation: newWorkspace,
    path: cwd,
    mode: options.worktreeMode,
    worktreeSlug: options.worktreeSlug ?? options.worktree,
    newBranch: options.newBranch,
    base: options.base,
    branch: options.branch,
    prNumber: options.prNumber,
    forge: options.forge,
  });
}

function toRunResult(
  agent: AgentSnapshotPayload,
  statusOverride?: AgentRunResult["status"],
): AgentRunResult {
  return {
    agentId: agent.id,
    status: statusOverride ?? (agent.status === "running" ? "running" : "created"),
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  };
}

function loadOutputSchema(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "--output-schema cannot be empty",
      details: "Provide a JSON schema file path or inline JSON object",
    };
    throw error;
  }

  let source = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      source = readFileSync(resolve(trimmed), "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error: CommandError = {
        code: "INVALID_OUTPUT_SCHEMA",
        message: `Failed to read output schema file: ${trimmed}`,
        details: message,
      };
      throw error;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "Failed to parse output schema JSON",
      details: message,
    };
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "Output schema must be a JSON object",
    };
    throw error;
  }

  return parsed as Record<string, unknown>;
}

class StructuredRunStatusError extends Error {
  readonly kind: "timeout" | "permission" | "error" | "empty";

  constructor(kind: "timeout" | "permission" | "error" | "empty", message: string) {
    super(message);
    this.name = "StructuredRunStatusError";
    this.kind = kind;
  }
}

async function fetchStructuredOutput(
  caller: (structuredPrompt: string) => Promise<string>,
  prompt: string,
  outputSchema: ReturnType<typeof loadOutputSchema>,
): Promise<Record<string, unknown>> {
  try {
    return await getStructuredAgentResponse<Record<string, unknown>>({
      caller,
      prompt,
      schema: outputSchema,
      schemaName: "RunOutput",
      maxRetries: 2,
    });
  } catch (err) {
    if (err instanceof StructuredRunStatusError) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: err.message,
      } satisfies CommandError;
    }
    if (err instanceof StructuredAgentResponseError) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: "Agent response did not match the required output schema",
        details:
          err.validationErrors.length > 0
            ? err.validationErrors.join("\n")
            : err.lastResponse || "No response",
      } satisfies CommandError;
    }
    throw err;
  }
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

export interface StructuredResponseTimelineClient {
  fetchAgentTimeline: ConnectedDaemonClient["fetchAgentTimeline"];
}

export async function resolveStructuredResponseMessage(options: {
  client: StructuredResponseTimelineClient;
  agentId: string;
  lastMessage: string | null;
}): Promise<string | null> {
  const direct = options.lastMessage?.trim();
  if (direct) {
    return direct;
  }

  try {
    const timeline = await options.client.fetchAgentTimeline(options.agentId, {
      direction: "tail",
      limit: 200,
    });
    for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
      const entry = timeline.entries[index];
      if (!entry || entry.item.type !== "assistant_message") {
        continue;
      }
      const text = entry.item.text.trim();
      if (text.length > 0) {
        return text;
      }
    }
  } catch {
    // Leave empty; caller will surface a consistent structured-output failure message.
  }

  return null;
}

function structuredRunSchema(output: Record<string, unknown>): OutputSchema<AgentRunResult> {
  return {
    ...agentRunSchema,
    serialize: () => output,
  };
}

function validateRunWorkspaceOptions(options: AgentRunOptions): void {
  const newWorkspace = resolveNewWorkspaceKind(options);
  if (
    options.newWorkspace &&
    options.newWorkspace !== "local" &&
    options.newWorkspace !== "worktree"
  ) {
    throw {
      code: "INVALID_OPTIONS",
      message: `Unsupported new workspace kind: ${options.newWorkspace}`,
      details: "Use --new-workspace local or --new-workspace worktree",
    } satisfies CommandError;
  }

  if (options.newWorkspace && options.worktree) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--new-workspace and --worktree cannot be combined",
      details: "Use --new-workspace worktree and the supported worktree options",
    } satisfies CommandError;
  }

  const hasWorktreeCreationOptions = [
    options.worktreeMode,
    options.worktreeSlug,
    options.newBranch,
    options.base,
    options.branch,
    options.prNumber,
    options.forge,
  ].some((value) => value !== undefined);
  if (hasWorktreeCreationOptions && newWorkspace !== "worktree") {
    throw {
      code: "INVALID_OPTIONS",
      message: "Worktree options require --new-workspace worktree",
      details: "Usage: paseo run --new-workspace worktree [worktree options] <prompt>",
    } satisfies CommandError;
  }

  if (newWorkspace === "worktree") {
    try {
      buildRunWorkspaceSource(options, options.cwd ?? process.cwd());
    } catch (error) {
      throw {
        code: "INVALID_OPTIONS",
        message: error instanceof Error ? error.message : String(error),
      } satisfies CommandError;
    }
  }

  if (options.newWorkspace && options.workspace) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--new-workspace and --workspace cannot be combined",
      details: "Select an existing workspace or explicitly create a new one",
    } satisfies CommandError;
  }

  // COMPAT(worktreeRunFlag): --worktree implies a new worktree-isolated workspace.
  // Added in v0.2.0; remove after 2027-01-17.
  if (options.worktree && options.workspace) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--worktree and --workspace cannot be combined",
      details: "Use --new-workspace worktree instead of the legacy --worktree flag",
    } satisfies CommandError;
  }
}

function validateRunOptions(prompt: string, options: AgentRunOptions, outputSchema: unknown): void {
  if (!prompt || prompt.trim().length === 0) {
    throw {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details: "Usage: paseo agent run [options] <prompt>",
    } satisfies CommandError;
  }

  validateRunWorkspaceOptions(options);

  const idempotencyKey = options.idempotencyKey?.trim();
  if (
    idempotencyKey !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(idempotencyKey)
  ) {
    throw {
      code: "INVALID_OPTIONS",
      message:
        "--idempotency-key must contain 1 to 200 letters, numbers, periods, underscores, colons, slashes, or hyphens",
    } satisfies CommandError;
  }

  if (outputSchema && runsInBackground(options)) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--output-schema cannot be used with --background",
      details: "Structured output requires waiting for the agent to finish",
    } satisfies CommandError;
  }
}

function runsInBackground(options: Pick<AgentRunOptions, "background" | "detach">): boolean {
  return Boolean(options.background || options.detach);
}

function parseWaitTimeoutOption(waitTimeout: string | undefined): number {
  if (!waitTimeout) return 0;
  try {
    const ms = parseDuration(waitTimeout);
    if (ms <= 0) {
      throw new Error("Timeout must be positive");
    }
    return ms;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "INVALID_TIMEOUT",
      message: "Invalid wait timeout value",
      details: message,
    } satisfies CommandError;
  }
}

function loadRunImages(
  imagePaths: string[] | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!imagePaths || imagePaths.length === 0) return undefined;
  return imagePaths.map((imagePath) => {
    const resolvedPath = resolve(imagePath);
    try {
      const imageData = readFileSync(resolvedPath);
      const mimeType = lookup(resolvedPath) || "application/octet-stream";
      if (!mimeType.startsWith("image/")) {
        throw new Error(`File is not an image: ${imagePath} (detected type: ${mimeType})`);
      }
      return {
        data: imageData.toString("base64"),
        mimeType,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read image ${imagePath}: ${message}`, { cause: err });
    }
  });
}

function parseRunLabels(labelFlags: string[] | undefined): Record<string, string> {
  return parseKeyValueFlags(labelFlags, {
    flagName: "--label",
    code: "INVALID_LABEL",
    noun: "label",
    pluralNoun: "Labels",
  });
}

function parseRunEnv(envFlags: string[] | undefined): Record<string, string> {
  return parseKeyValueFlags(envFlags, {
    flagName: "--env",
    code: "INVALID_ENV",
    noun: "environment variable",
    pluralNoun: "Environment variables",
  });
}

function parseKeyValueFlags(
  flags: string[] | undefined,
  options: {
    flagName: string;
    code: CommandError["code"];
    noun: string;
    pluralNoun: string;
  },
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!flags) return labels;
  for (const labelStr of flags) {
    const eqIndex = labelStr.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: options.code,
        message: `Invalid ${options.noun} format: ${labelStr}`,
        details: `${options.pluralNoun} must be in key=value format`,
      } satisfies CommandError;
    }
    const key = labelStr.slice(0, eqIndex);
    labels[key] = labelStr.slice(eqIndex + 1);
  }
  return labels;
}

async function connectToDaemonOrThrow(
  hostOption: string | undefined,
  host: string,
): Promise<ConnectedDaemonClient> {
  try {
    return await connectToDaemon({ host: hostOption });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

// A workspace is the explicit home of a run. Modern daemons receive its source
// together with create-agent and own the operation atomically; the separate
// create-workspace path remains only for compatibility with older daemons.
interface RunWorkspace {
  id?: string;
  cwd: string;
  source?: WorkspaceCreateRequest["source"];
}

export interface RunWorkspaceLookupClient {
  fetchWorkspaces(options: { filter: { query: string }; page: { limit: number } }): Promise<{
    entries: Array<{ id: string; workspaceDirectory: string }>;
    pageInfo: { nextCursor: string | null };
  }>;
}

export async function resolveExistingRunWorkspace(
  client: RunWorkspaceLookupClient,
  workspaceId: string,
): Promise<RunWorkspace> {
  const result = await client.fetchWorkspaces({
    filter: { query: workspaceId },
    page: { limit: 200 },
  });
  const workspace = result.entries.find((entry) => entry.id === workspaceId);
  if (workspace) {
    return { id: workspace.id, cwd: workspace.workspaceDirectory };
  }

  throw {
    code: "WORKSPACE_NOT_FOUND",
    message: `Workspace not found: ${workspaceId}`,
  } satisfies CommandError;
}

// Workspace policy for `paseo run`. Precedence:
//   1. --workspace <id>            -> run in that existing workspace
//   2. $PASEO_AGENT_ID             -> daemon resolves the caller's workspace
//   3. $PASEO_WORKSPACE_ID         -> exported by workspace terminals
//   4. --new-workspace <kind>      -> mint a new workspace explicitly
//   5. bare run                    -> mint a new local-backed workspace for cwd
export async function resolveRunWorkspace(
  client: ConnectedDaemonClient,
  options: AgentRunOptions,
  cwd: string,
): Promise<RunWorkspace> {
  const newWorkspace = resolveNewWorkspaceKind(options);
  const explicit = newWorkspace ? undefined : options.workspace?.trim();
  if (explicit) {
    console.error(`Using workspace ${explicit}`);
    return resolveExistingRunWorkspace(client, explicit);
  }

  if (!newWorkspace && resolveRunCallerAgentId()) {
    return { cwd };
  }

  const ambientWorkspaceId = newWorkspace ? undefined : process.env.PASEO_WORKSPACE_ID?.trim();
  if (ambientWorkspaceId) {
    console.error(`Using workspace ${ambientWorkspaceId}`);
    return resolveExistingRunWorkspace(client, ambientWorkspaceId);
  }

  // TODO: thread the run `prompt` as firstAgentContext so workspace-level
  // title/branch generation picks up the task description (U8/U6 deferred).
  const source = buildRunWorkspaceSource(options, cwd);
  const supportsAtomicWorkspaceAgentCreate =
    client.getLastServerInfoMessage()?.features?.createAgentIdempotency === true;
  if (options.idempotencyKey || supportsAtomicWorkspaceAgentCreate) {
    return { cwd, source };
  }
  const result = await client.createWorkspace({ source });

  if (!result.workspace) {
    throw {
      code: "WORKSPACE_CREATE_FAILED",
      message: result.error ?? "Failed to create workspace for this run",
    } satisfies CommandError;
  }

  const branch = result.workspace.gitRuntime?.currentBranch;
  const label = branch ? `${result.workspace.name} (${branch})` : result.workspace.name;
  console.error(`Created workspace ${result.workspace.id} - ${label}`);
  console.error(
    "Tip: pass --workspace <id> (or set PASEO_WORKSPACE_ID) to run in an existing workspace.",
  );
  return { id: result.workspace.id, cwd: result.workspace.workspaceDirectory ?? cwd };
}

export async function runRunCommand(
  prompt: string,
  options: AgentRunOptions,
  _command: Command,
): Promise<SingleResult<AgentRunResult>> {
  const inputs = resolveLocalRunInputs(prompt, options);
  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemonOrThrow(options.host, host);
  let intent: AgentRunIntent | null = null;

  try {
    intent = await resolveAgentRunIntent(client, inputs, options);
    return await executeAgentRunIntent(client, intent);
  } catch (err) {
    const legacyWorkspaceId = resolveLegacyRunCreatedWorkspaceId(intent, options);
    if (legacyWorkspaceId && isDefiniteAgentCreateRejection(err)) {
      if (await rollbackDefiniteLegacyRunWorkspace(client, legacyWorkspaceId)) {
        throw normalizeRunError(err);
      }
    }
    throw normalizeRunErrorWithWorkspaceReceipt(err, intent, options);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function rollbackDefiniteLegacyRunWorkspace(
  client: Pick<ConnectedDaemonClient, "archiveWorkspace">,
  workspaceId: string,
): Promise<boolean> {
  try {
    const archived = await client.archiveWorkspace(workspaceId);
    if (!archived.error) return true;
    console.error(`Warning: failed to clean up workspace ${workspaceId}: ${archived.error}`);
  } catch (cleanupError) {
    console.error(
      `Warning: failed to clean up workspace ${workspaceId}: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    );
  }
  return false;
}

function isDefiniteAgentCreateRejection(error: unknown): boolean {
  return error instanceof DaemonRpcError && error.requestType === "create_agent_request";
}

function resolveLegacyRunCreatedWorkspaceId(
  intent: AgentRunIntent | null,
  options: AgentRunOptions,
): string | null {
  const workspaceId = intent?.create.workspaceId;
  if (!workspaceId || intent?.create.workspaceSource) return null;
  if (
    options.idempotencyKey?.trim() ||
    options.workspace?.trim() ||
    process.env.PASEO_WORKSPACE_ID?.trim() ||
    resolveRunCallerAgentId()
  ) {
    return null;
  }
  return workspaceId;
}

export function normalizeRunErrorWithWorkspaceReceipt(
  error: unknown,
  intent: AgentRunIntent | null,
  options: AgentRunOptions,
): unknown {
  const normalized = normalizeRunError(error);
  const workspaceId = resolveLegacyRunCreatedWorkspaceId(intent, options);
  if (!workspaceId) {
    if (intent?.create.workspaceSource && !isDefiniteAgentCreateRejection(error)) {
      const commandError = normalized as CommandError;
      const idempotencyKey = intent.create.idempotencyKey?.trim();
      return {
        ...commandError,
        code: "AGENT_CREATE_OUTCOME_UNKNOWN",
        details: {
          recovery: idempotencyKey
            ? `The daemon did not confirm the atomic create response. Retry with the same --idempotency-key ${idempotencyKey}; it will reuse the original placement and agent.`
            : "The daemon did not confirm the atomic create response. Inspect the agent and workspace lists before retrying; the daemon may have completed the request.",
          cause: describeRunError(error, commandError),
        },
      } satisfies CommandError;
    }
    return normalized;
  }

  const commandError = normalized as CommandError;
  return {
    ...commandError,
    code: "AGENT_CREATE_FAILED_WORKSPACE_PRESERVED",
    details: {
      recovery:
        `Workspace ${workspaceId} was preserved at ${intent?.create.config.cwd}. ` +
        `Inspect it or retry with --workspace ${workspaceId}; do not create another workspace.`,
      cause: describeRunError(error, commandError),
    },
  } satisfies CommandError;
}

function describeRunError(error: unknown, normalized: CommandError) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: normalized.message,
    code: normalized.code,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

interface LocalRunInputs {
  prompt: string;
  outputSchema: Record<string, unknown> | undefined;
  waitTimeoutMs: number;
  resolvedProviderModel: ReturnType<typeof resolveProviderAndModel>;
  resolvedTitle: string | undefined;
  cwd: string;
  thinkingOptionId: string | undefined;
  images: ReturnType<typeof loadRunImages>;
  requestEnv: Record<string, string> | undefined;
  labels: Record<string, string> | undefined;
  background: boolean;
}

function resolveLocalRunInputs(prompt: string, options: AgentRunOptions): LocalRunInputs {
  const outputSchema = options.outputSchema ? loadOutputSchema(options.outputSchema) : undefined;
  validateRunOptions(prompt, options, outputSchema);
  const thinkingOptionId = options.thinking?.trim();
  if (options.thinking !== undefined && !thinkingOptionId) {
    throw {
      code: "INVALID_THINKING_OPTION",
      message: "--thinking cannot be empty",
      details:
        'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
    } satisfies CommandError;
  }
  const env = parseRunEnv(options.env);
  const labels = parseRunLabels(options.label);
  return {
    prompt,
    outputSchema,
    waitTimeoutMs: parseWaitTimeoutOption(options.waitTimeout),
    resolvedProviderModel: resolveProviderAndModel(options),
    resolvedTitle: options.title ?? options.name,
    cwd: options.cwd ?? process.cwd(),
    thinkingOptionId,
    images: loadRunImages(options.image),
    requestEnv: Object.keys(env).length > 0 ? env : undefined,
    labels: Object.keys(labels).length > 0 ? labels : undefined,
    background: runsInBackground(options),
  };
}

async function resolveAgentRunIntent(
  client: ConnectedDaemonClient,
  inputs: LocalRunInputs,
  options: AgentRunOptions,
): Promise<AgentRunIntent> {
  const { CreateAgentRequestMessageSchema } = await import("@getpaseo/protocol/messages");
  const workspace = await resolveRunWorkspace(client, options, inputs.cwd);
  const request = CreateAgentRequestMessageSchema.parse({
    type: "create_agent_request",
    requestId: "resolved-run-intent",
    config: {
      provider: inputs.resolvedProviderModel.provider,
      cwd: workspace.cwd,
      title: inputs.resolvedTitle,
      modeId: options.mode,
      model: inputs.resolvedProviderModel.model,
      thinkingOptionId: inputs.thinkingOptionId,
    },
    workspaceId: workspace.id,
    workspaceSource: workspace.source,
    callerAgentId: resolveRunCallerAgentId(),
    initialPrompt: inputs.prompt,
    idempotencyKey: options.idempotencyKey?.trim(),
    outputSchema: inputs.outputSchema,
    images: inputs.images,
    env: inputs.requestEnv,
    labels: inputs.labels,
  });
  const { requestId: _requestId, ...create } = request;
  return parseAgentRunIntent({
    create,
    prompt: inputs.prompt,
    waitTimeoutMs: inputs.waitTimeoutMs,
    background: inputs.background,
  });
}

export async function prepareAgentRunIntent(
  prompt: string,
  options: AgentRunOptions,
): Promise<{ intent: AgentRunIntent; daemonId: string }> {
  const inputs = resolveLocalRunInputs(prompt, options);
  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemonOrThrow(options.host, host);
  try {
    const intent = await resolveAgentRunIntent(client, inputs, options);
    return { intent, daemonId: requireDaemonIdentity(client) };
  } catch (error) {
    throw normalizeRunError(error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runAgentRunIntent(input: {
  intent: AgentRunIntent;
  host: string;
  expectedDaemonId: string;
  idempotencyKey: string;
}): Promise<SingleResult<AgentRunResult>> {
  const persistedIntent = await parseAgentRunIntent(input.intent);
  const { idempotencyKey: _persistedIdempotencyKey, ...create } = persistedIntent.create;
  const intent = await parseAgentRunIntent({
    ...persistedIntent,
    create: {
      ...create,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const client = await connectToDaemonOrThrow(input.host, getDaemonHost({ host: input.host }));
  try {
    const actualDaemonId = requireDaemonIdentity(client);
    if (actualDaemonId !== input.expectedDaemonId) {
      throw {
        code: "FLEET_DAEMON_IDENTITY_MISMATCH",
        message: `Fleet host now points to daemon ${actualDaemonId}, not original daemon ${input.expectedDaemonId}`,
        details: "Restore the original daemon mapping or use a new idempotency key.",
      } satisfies CommandError;
    }
    return await executeAgentRunIntent(client, intent);
  } catch (error) {
    throw normalizeRunError(error);
  } finally {
    await client.close().catch(() => {});
  }
}

function requireDaemonIdentity(client: ConnectedDaemonClient): string {
  const daemonId = client.getLastServerInfoMessage()?.serverId.trim();
  if (!daemonId) {
    throw {
      code: "FLEET_DAEMON_IDENTITY_UNAVAILABLE",
      message: "The fleet host did not provide a stable daemon identity",
      details: "Update the host before using retry-safe fleet creation.",
    } satisfies CommandError;
  }
  return daemonId;
}

async function executeAgentRunIntent(
  client: ConnectedDaemonClient,
  intent: AgentRunIntent,
): Promise<SingleResult<AgentRunResult>> {
  const { type: _type, ...createOptions } = intent.create;
  const outputSchema = intent.create.outputSchema;
  if (outputSchema) {
    let structuredAgent: AgentSnapshotPayload | null = null;
    const callStructuredTurn = async (structuredPrompt: string): Promise<string> => {
      if (!structuredAgent) {
        structuredAgent = await client.createAgent({
          ...createOptions,
          initialPrompt: structuredPrompt,
        });
      } else {
        await client.sendMessage(structuredAgent.id, structuredPrompt);
      }
      const state = await client.waitForFinish(structuredAgent.id, intent.waitTimeoutMs);
      if (state.status === "timeout") {
        throw new StructuredRunStatusError("timeout", "Timed out waiting for structured output");
      }
      if (state.status === "permission") {
        throw new StructuredRunStatusError(
          "permission",
          "Agent is waiting for permission before producing structured output",
        );
      }
      if (state.status === "error") {
        throw new StructuredRunStatusError(
          "error",
          state.error ?? "Agent failed before producing structured output",
        );
      }
      const lastMessage = await resolveStructuredResponseMessage({
        client,
        agentId: structuredAgent.id,
        lastMessage: state.lastMessage,
      });
      if (!lastMessage) {
        throw new StructuredRunStatusError(
          "empty",
          "Agent finished without a structured output message",
        );
      }
      return lastMessage;
    };
    const output = await fetchStructuredOutput(callStructuredTurn, intent.prompt, outputSchema);
    if (!structuredAgent) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: "Agent finished without a structured output message",
      } satisfies CommandError;
    }
    return {
      type: "single",
      data: toRunResult(structuredAgent, "completed"),
      schema: structuredRunSchema(output),
    };
  }

  const agent = await client.createAgent(createOptions);
  if (!intent.background) {
    const state = await client.waitForFinish(agent.id, intent.waitTimeoutMs);
    const finalAgent = state.final ?? agent;
    const status: AgentRunResult["status"] = state.status === "idle" ? "completed" : state.status;
    return { type: "single", data: toRunResult(finalAgent, status), schema: agentRunSchema };
  }
  return { type: "single", data: toRunResult(agent), schema: agentRunSchema };
}

function normalizeRunError(error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    const code = typeof error.code === "string" ? error.code : "AGENT_CREATE_FAILED";
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    } else if ("message" in error && typeof error.message === "string") {
      message = error.message;
    }
    let details: unknown;
    if ("details" in error) {
      details = error.details;
    } else if (error instanceof Error && error.stack) {
      details = error.stack;
    }
    return {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "AGENT_CREATE_FAILED",
    message: `Failed to create agent: ${message}`,
  } satisfies CommandError;
}

export function resolveRunCallerAgentId(
  env: { PASEO_AGENT_ID?: string } = process.env,
): string | undefined {
  return env.PASEO_AGENT_ID?.trim() || undefined;
}
