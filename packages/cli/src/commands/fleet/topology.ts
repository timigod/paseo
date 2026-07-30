import path from "node:path";

export const FLEET_TOPOLOGY_VERSION = 1;
export const FLEET_DEFAULT_PROVIDER = "opencode";
export const FLEET_DEFAULT_MODEL = "plexer-openai/gpt-5.6-terra";
export const FLEET_DEFAULT_THINKING = "high";

export interface FleetHost {
  id: "macbook" | "imac";
  name: string;
  endpoint: string;
  codeRoot: string;
  hostnamePrefixes: readonly string[];
  capacity: number;
}

/**
 * This is deliberately versioned source, rather than an orchestrator prompt or
 * one machine's private daemon state. The runtime-source convergence path keeps
 * this declaration identical on the MacBook and iMac.
 */
export const FLEET_HOSTS: readonly FleetHost[] = [
  {
    id: "macbook",
    name: "MacBook",
    endpoint: "100.108.191.125:6767",
    codeRoot: "/Users/timiajiboye/Code",
    hostnamePrefixes: ["timis-macbook-pro"],
    capacity: 10,
  },
  {
    id: "imac",
    name: "iMac",
    endpoint: "imac.tail24bbb3.ts.net:6767",
    codeRoot: "/Users/timi/Code",
    hostnamePrefixes: ["imac"],
    capacity: 10,
  },
] as const;

export type FleetHostId = FleetHost["id"];

export function findFleetHost(
  value: string,
  hosts: readonly FleetHost[] = FLEET_HOSTS,
): FleetHost | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return (
    hosts.find((host) => host.id === normalized || host.endpoint.toLowerCase() === normalized) ??
    null
  );
}

export function findFleetHostForHostname(
  hostname: string,
  hosts: readonly FleetHost[] = FLEET_HOSTS,
): FleetHost | null {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return null;
  return (
    hosts.find((host) =>
      host.hostnamePrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase())),
    ) ?? null
  );
}

export function findFleetHostForCwd(
  cwd: string,
  hosts: readonly FleetHost[] = FLEET_HOSTS,
): FleetHost | null {
  const resolvedCwd = path.resolve(cwd);
  return (
    hosts.find((host) => {
      const relative = path.relative(host.codeRoot, resolvedCwd);
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
    }) ?? null
  );
}

export function translateFleetCwd(cwd: string, from: FleetHost, to: FleetHost): string {
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(from.codeRoot, resolvedCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${resolvedCwd} is outside the ${from.id} fleet code root`);
  }
  return path.join(to.codeRoot, relative);
}
