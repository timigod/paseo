import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CommandError } from "../../output/index.js";

export const FLEET_TOPOLOGY_VERSION = 1;

export const FleetHostSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  endpoint: z.string().trim().min(1),
  codeRoot: z.string().trim().min(1),
  hostnamePrefixes: z.array(z.string().trim().min(1)),
  capacity: z.number().int().positive(),
});

const FleetDefaultsSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  thinking: z.string().trim().min(1).optional(),
});

const FleetConfigSchema = z
  .object({
    version: z.literal(FLEET_TOPOLOGY_VERSION),
    hosts: z.array(FleetHostSchema).min(1),
    defaults: FleetDefaultsSchema,
  })
  .superRefine(({ hosts }, context) => {
    const hostIds = new Set<string>();
    const endpoints = new Set<string>();
    for (const [index, host] of hosts.entries()) {
      const normalizedId = host.id.toLowerCase();
      if (hostIds.has(normalizedId)) {
        context.addIssue({
          code: "custom",
          path: ["hosts", index, "id"],
          message: "Fleet host IDs must be unique",
        });
      }
      hostIds.add(normalizedId);

      const normalizedEndpoint = host.endpoint.toLowerCase();
      if (endpoints.has(normalizedEndpoint)) {
        context.addIssue({
          code: "custom",
          path: ["hosts", index, "endpoint"],
          message: "Fleet host endpoints must be unique",
        });
      }
      endpoints.add(normalizedEndpoint);
    }
  });

export type FleetHost = z.infer<typeof FleetHostSchema>;
export type FleetDefaults = z.infer<typeof FleetDefaultsSchema>;
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

function expandHomeDirectory(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveFleetConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = env.PASEO_FLEET_CONFIG?.trim();
  if (configuredPath) return path.resolve(expandHomeDirectory(configuredPath));
  const paseoHome = expandHomeDirectory(env.PASEO_HOME?.trim() || path.join("~", ".paseo"));
  return path.resolve(paseoHome, "fleet.json");
}

export function loadFleetConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
  let source: string;
  try {
    source = readFileSync(resolveFleetConfigPath(env), "utf8");
  } catch {
    throw {
      code: "FLEET_CONFIG_UNAVAILABLE",
      message: "Fleet configuration is unavailable",
      details: "Create $PASEO_HOME/fleet.json or set PASEO_FLEET_CONFIG to a fleet JSON file.",
    } satisfies CommandError;
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    throw {
      code: "FLEET_CONFIG_INVALID",
      message: "Fleet configuration is not valid JSON",
    } satisfies CommandError;
  }

  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw {
      code: "FLEET_CONFIG_INVALID",
      message: "Fleet configuration does not match the supported schema",
      details: parsed.error.issues.map((issue) => issue.message).join("; "),
    } satisfies CommandError;
  }
  return parsed.data;
}

export function findFleetHost(value: string, hosts: readonly FleetHost[]): FleetHost | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return (
    hosts.find(
      (host) => host.id.toLowerCase() === normalized || host.endpoint.toLowerCase() === normalized,
    ) ?? null
  );
}

export function findFleetHostById(value: string, hosts: readonly FleetHost[]): FleetHost | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return hosts.find((host) => host.id.toLowerCase() === normalized) ?? null;
}

export function findFleetHostForHostname(
  hostname: string,
  hosts: readonly FleetHost[],
): FleetHost | null {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return null;
  return (
    hosts.find((host) =>
      host.hostnamePrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase())),
    ) ?? null
  );
}

export function findFleetHostForCwd(cwd: string, hosts: readonly FleetHost[]): FleetHost | null {
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
