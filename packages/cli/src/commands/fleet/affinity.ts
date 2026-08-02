import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { publishPrivateFile } from "../../utils/private-file.js";
import { FleetHostSchema, resolveFleetConfigPath, type FleetHost } from "./topology.js";

const FleetAffinitySchema = z
  .object({
    version: z.literal(1),
    host: FleetHostSchema,
    cwd: z.string().min(1),
  })
  .strict();

export interface FleetAffinity {
  host: FleetHost;
  cwd: string;
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
  const parsed = FleetAffinitySchema.parse(JSON.parse(raw));
  return { host: parsed.host, cwd: parsed.cwd };
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
  const filePath = resolveAffinityFile(input);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (
    await publishPrivateFile(filePath, JSON.stringify({ version: 1, ...input.affinity }, null, 2))
  ) {
    return input.affinity;
  }
  const winner = await readAffinity(filePath);
  if (!winner) {
    throw new Error("Fleet affinity disappeared during concurrent creation");
  }
  return winner;
}
