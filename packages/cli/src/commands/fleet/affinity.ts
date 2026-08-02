import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { publishPrivateFile } from "../../utils/private-file.js";
import { parseAgentRunIntent, type AgentRunIntent } from "../agent/run-intent.js";
import { FleetHostSchema, resolveFleetConfigPath, type FleetHost } from "./topology.js";

// COMPAT(fleetAffinityV1): version 1 did not persist enough create intent to replay safely.
// Added in v0.2.5; remove after 2027-02-02.
const LegacyFleetAffinitySchema = z
  .object({
    version: z.literal(1),
    host: FleetHostSchema,
    cwd: z.string().min(1),
  })
  .strict();

const FleetAffinitySchema = z
  .object({
    version: z.literal(2),
    host: FleetHostSchema,
    daemonId: z.string().trim().min(1),
    intent: z.unknown(),
  })
  .strict();

export interface FleetAffinity {
  host: FleetHost;
  daemonId: string;
  intent: AgentRunIntent;
}

function resolveAffinityFile(input: {
  callerId: string;
  idempotencyKey: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const digest = createHash("sha256")
    .update(`${input.callerId}\0${input.idempotencyKey}`)
    .digest("hex");
  return path.join(
    path.dirname(resolveFleetConfigPath(input.env)),
    "fleet-create-affinity",
    `${digest}.json`,
  );
}

async function readAffinity(filePath: string): Promise<FleetAffinity | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const json: unknown = JSON.parse(raw);
  if (LegacyFleetAffinitySchema.safeParse(json).success) {
    throw new Error(
      "This fleet create key predates durable create intents and cannot be retried safely; inspect the original host and use a new idempotency key",
    );
  }
  const { host, daemonId, intent } = FleetAffinitySchema.parse(json);
  return { host, daemonId, intent: await parseAgentRunIntent(intent) };
}

export async function loadFleetAffinity(input: {
  callerId: string;
  idempotencyKey: string;
  env?: NodeJS.ProcessEnv;
}): Promise<FleetAffinity | null> {
  return readAffinity(resolveAffinityFile(input));
}

export async function claimFleetAffinity(input: {
  callerId: string;
  idempotencyKey: string;
  affinity: FleetAffinity;
  env?: NodeJS.ProcessEnv;
}): Promise<FleetAffinity> {
  const sanitized = withoutTransportIdentity(input.affinity);
  const { host, daemonId, intent } = FleetAffinitySchema.parse({
    version: 2,
    ...sanitized,
  });
  const affinity: FleetAffinity = {
    host,
    daemonId,
    intent: await parseAgentRunIntent(intent),
  };
  const filePath = resolveAffinityFile(input);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (await publishPrivateFile(filePath, JSON.stringify({ version: 2, ...affinity }, null, 2))) {
    return affinity;
  }
  const winner = await readAffinity(filePath);
  if (!winner) {
    throw new Error("Fleet affinity disappeared during concurrent creation");
  }
  return winner;
}

function withoutTransportIdentity(affinity: FleetAffinity): FleetAffinity {
  const { idempotencyKey: _idempotencyKey, ...create } = affinity.intent.create;
  return {
    ...affinity,
    intent: {
      ...affinity.intent,
      create,
    },
  };
}
