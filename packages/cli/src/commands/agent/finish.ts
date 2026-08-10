import type { AgentFinishReceipt } from "@getpaseo/protocol/messages";
import { Command } from "commander";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";

export type AgentFinishResult = AgentFinishReceipt;

export const finishSchema: OutputSchema<AgentFinishResult> = {
  idField: "operationId",
  columns: [
    { header: "OPERATION ID", field: "operationId" },
    { header: "AGENT ID", field: "agentId" },
    { header: "WORKSPACE ID", field: "workspaceId" },
    { header: "ARCHIVED AT", field: "archivedAt" },
    { header: "WORKSPACE RELEASED", field: "workspaceReleased" },
    { header: "REMOVED DIRECTORY", field: "removedDirectory" },
  ],
};

export function addFinishOptions(cmd: Command): Command {
  return cmd
    .description("Atomically archive an agent and release its workspace when unowned")
    .argument("<agent-id>", "Exact agent ID")
    .requiredOption("--workspace-id <workspace-id>", "Exact workspace ID")
    .requiredOption("--operation-id <operation-id>", "Stable idempotency operation ID");
}

export interface AgentFinishOptions extends CommandOptions {
  workspaceId?: string;
  operationId?: string;
  host?: string;
}

export async function runFinishCommand(
  agentId: string,
  options: AgentFinishOptions,
  _command: Command,
): Promise<SingleResult<AgentFinishResult>> {
  if (!options.workspaceId || !options.operationId) {
    throw {
      code: "MISSING_ARGUMENT",
      message: "Workspace ID and operation ID are required",
    } satisfies CommandError;
  }

  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });

  try {
    const payload = await client.finishAgent({
      operationId: options.operationId,
      agentId,
      workspaceId: options.workspaceId,
    });
    const { requestId: _requestId, ...receipt } = payload;
    return {
      type: "single",
      data: receipt,
      schema: finishSchema,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "ATOMIC_FINISH_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
