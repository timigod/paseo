import { Command } from "commander";
import type { AgentReloadCommandResult, AgentReloadOptions } from "./reload.js";
import { runReloadCommand } from "./reload.js";

export function addRecoverOptions(cmd: Command): Command {
  return cmd
    .description("Recover an archived or stopped agent from its persisted session")
    .argument("<id>", "Agent ID, prefix, or name");
}

export type AgentRecoverOptions = AgentReloadOptions;
export type AgentRecoverCommandResult = AgentReloadCommandResult;

// Recovery deliberately reuses reload: the daemon has one authoritative
// session-resume path, so recovery cannot drift into a competing lifecycle.
export async function runRecoverCommand(
  agentIdArg: string,
  options: AgentRecoverOptions,
  command: Command,
): Promise<AgentRecoverCommandResult> {
  return runReloadCommand(agentIdArg, options, command);
}
