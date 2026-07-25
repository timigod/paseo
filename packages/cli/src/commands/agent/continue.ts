import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, SingleResult } from "../../output/index.js";
import {
  addSendOptions,
  type AgentSendOptions,
  type AgentSendResult,
  runSendCommand,
} from "./send.js";
import { runRecoverCommand } from "./recover.js";

export type AgentContinueOptions = AgentSendOptions;
export type AgentContinueCommandResult = SingleResult<AgentSendResult>;

export function addContinueOptions(cmd: Command): Command {
  return addSendOptions(cmd)
    .name("continue")
    .description("Continue a task: recover it if needed, then send its next instruction");
}

export async function runContinueCommand(
  agentIdArg: string,
  prompt: string | undefined,
  options: AgentContinueOptions,
  command: Command,
): Promise<AgentContinueCommandResult> {
  const host = getDaemonHost({ host: options.host });
  let client: Awaited<ReturnType<typeof connectToDaemon>>;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }

  let agent: NonNullable<Awaited<ReturnType<typeof client.fetchAgent>>>["agent"];
  try {
    const target = await client.fetchAgent({ agentId: agentIdArg });
    if (!target) {
      throw new Error(`Agent not found: ${agentIdArg}`);
    }
    agent = target.agent;
  } catch (err) {
    await client.close().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Agent not found:")) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls --global" to find active and archived tasks',
      } satisfies CommandError;
    }
    throw err;
  }
  await client.close();

  if (agent.archivedAt) {
    await runRecoverCommand(agent.id, { host: options.host }, command);
  }
  return runSendCommand(agent.id, prompt, options, command);
}
