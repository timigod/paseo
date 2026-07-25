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

// Recovery is intentionally the same daemon operation as reload: it first
// unarchives provider/session state, restores the owning workspace record, and
// then resumes the persisted session. Keeping one implementation prevents the
// recovery command from becoming a second lifecycle authority.
export async function runRecoverCommand(
  agentIdArg: string,
  options: AgentRecoverOptions,
  command: Command,
): Promise<AgentRecoverCommandResult> {
  return runReloadCommand(agentIdArg, options, command);
}
