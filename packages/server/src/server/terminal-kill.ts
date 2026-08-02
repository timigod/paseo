import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  assertDestructiveActionAuthorized,
  type DestructiveActionRecheck,
  type DestructiveCallerContext,
  type LiveAgentAuthority,
} from "./agent/destructive-action-authority.js";

export interface AuthorizedTerminalKillDependencies {
  readonly agentAuthority: LiveAgentAuthority;
  readonly terminalManager: Pick<
    TerminalManager,
    "getTerminal" | "killTerminal" | "killTerminalAndWait"
  >;
  readonly beforeKill?: (terminalId: string) => void;
}

export function createTerminalKillRecheck(
  dependencies: Pick<AuthorizedTerminalKillDependencies, "agentAuthority" | "terminalManager">,
  terminalId: string,
  caller: DestructiveCallerContext,
  signal?: AbortSignal,
): DestructiveActionRecheck {
  return () => {
    const terminal = dependencies.terminalManager.getTerminal(terminalId);
    assertDestructiveActionAuthorized(
      dependencies.agentAuthority,
      caller,
      {
        action: "terminal.kill",
        targetAgentIds: [],
        targetWorkspaceIds: terminal?.workspaceId ? [terminal.workspaceId] : [],
        targetPaths: terminal?.cwd ? [terminal.cwd] : [],
        hasLiveTarget: terminal !== undefined,
      },
      signal,
    );
  };
}

export async function killTerminalWithRecheck(
  dependencies: Pick<AuthorizedTerminalKillDependencies, "terminalManager" | "beforeKill">,
  terminalId: string,
  recheck: DestructiveActionRecheck,
  options?: {
    wait?: boolean;
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  },
): Promise<boolean> {
  await recheck();
  if (!dependencies.terminalManager.getTerminal(terminalId)) {
    return false;
  }
  await recheck();
  if (!dependencies.terminalManager.getTerminal(terminalId)) {
    return false;
  }
  dependencies.beforeKill?.(terminalId);

  if (options?.wait) {
    await dependencies.terminalManager.killTerminalAndWait(terminalId, {
      ...(options.gracefulTimeoutMs === undefined
        ? {}
        : { gracefulTimeoutMs: options.gracefulTimeoutMs }),
      ...(options.forceTimeoutMs === undefined ? {} : { forceTimeoutMs: options.forceTimeoutMs }),
    });
  } else {
    dependencies.terminalManager.killTerminal(terminalId);
  }
  return true;
}

export async function killTerminalWithAuthority(
  dependencies: AuthorizedTerminalKillDependencies,
  terminalId: string,
  caller: DestructiveCallerContext,
  options?: {
    signal?: AbortSignal;
    wait?: boolean;
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  },
): Promise<boolean> {
  return killTerminalWithRecheck(
    dependencies,
    terminalId,
    createTerminalKillRecheck(dependencies, terminalId, caller, options?.signal),
    options,
  );
}
