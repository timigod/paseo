import { chmod, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { publishPrivateFile } from "./private-file.js";

const CLIENT_SESSION_KEY_FILE = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "cli-client-id",
);

let cachedClientId: string | null = null;

function normalizeClientId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateClientId(): string {
  return `cid_${randomUUID().replace(/-/g, "")}`;
}

export async function getOrCreateCliClientId(): Promise<string> {
  if (cachedClientId) {
    return cachedClientId;
  }

  try {
    const existing = normalizeClientId(await readFile(CLIENT_SESSION_KEY_FILE, "utf8"));
    if (existing) {
      cachedClientId = existing;
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const nextValue = generateClientId();
  const directory = dirname(CLIENT_SESSION_KEY_FILE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (await publishPrivateFile(CLIENT_SESSION_KEY_FILE, nextValue)) {
    cachedClientId = nextValue;
    return nextValue;
  }
  const existing = normalizeClientId(await readFile(CLIENT_SESSION_KEY_FILE, "utf8"));
  if (!existing) {
    throw new Error("CLI client identity file is empty after concurrent creation");
  }
  cachedClientId = existing;
  return existing;
}
