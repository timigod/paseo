import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOCAL_COORDINATOR_ROUTING_CAPABILITY_FILENAME = "coordinator-auth-token";

export function resolveLocalCoordinatorAuthorizationHeaders(
  paseoHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // A managed descendant must never fall back to the same-user coordinator
  // routing file. This is a fail-closed product boundary, not hostile same-UID
  // process isolation.
  if (env.PASEO_MANAGED_AGENT_CONTEXT === "1") {
    return {};
  }
  try {
    const token = readFileSync(
      join(paseoHome, LOCAL_COORDINATOR_ROUTING_CAPABILITY_FILENAME),
      "utf8",
    ).trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
