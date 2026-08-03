import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";

const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

export const PASEO_MANAGED_AGENT_CONTEXT = "PASEO_MANAGED_AGENT_CONTEXT";

const MANAGED_CHILD_COORDINATOR_ENV_KEYS = [
  "PASEO_PASSWORD",
  "PASEO_COORDINATOR_AUTH_TOKEN",
  "PASEO_COORDINATOR_CAPABILITY",
] as const;

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SERVICE_MANAGED",
  "PASEO_SUPERVISED",
  "PASEO_SUPERVISOR_WORKER_TOKEN",
  "PASEO_SUPERVISOR_INCARNATION",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  // This marker is an inherited product boundary for daemon-managed children.
  // It prevents ordinary CLI/Desktop code in a provider, terminal, or helper
  // descendant from falling back to the local coordinator routing capability.
  // It is not isolation from deliberately hostile code running as the same OS
  // user, which can inspect or alter its own environment and local-user files.
  sanitized[PASEO_MANAGED_AGENT_CONTEXT] = "1";
  for (const key of MANAGED_CHILD_COORDINATOR_ENV_KEYS) {
    delete sanitized[key];
  }
  if (isPairingOfferHost(sanitized.PASEO_HOST)) {
    delete sanitized.PASEO_HOST;
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

function isPairingOfferHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return parseConnectionOfferFromUrl(host) !== null;
  } catch {
    return false;
  }
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function applyManagedChildEnvOverlay(env: ProcessEnvRecord): void {
  env[PASEO_MANAGED_AGENT_CONTEXT] = "1";
  for (const key of MANAGED_CHILD_COORDINATOR_ENV_KEYS) {
    env[key] = undefined;
  }
}

export function isManagedAgentContext(env: ProcessEnvRecord = process.env): boolean {
  return env[PASEO_MANAGED_AGENT_CONTEXT] === "1";
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, envOverlay ? [envOverlay] : []);
  env[ELECTRON_RUN_AS_NODE] = "1";
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
