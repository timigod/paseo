import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const COORDINATOR_CAPABILITY_FILENAME = "coordinator-auth-token";

export function coordinatorCapabilityPath(paseoHome: string): string {
  return join(paseoHome, COORDINATOR_CAPABILITY_FILENAME);
}

export async function writeCoordinatorCapability(paseoHome: string, token: string): Promise<void> {
  const filePath = coordinatorCapabilityPath(paseoHome);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(token, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readCoordinatorCapability(paseoHome: string): Promise<string | null> {
  try {
    const token = (await readFile(coordinatorCapabilityPath(paseoHome), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function removeCoordinatorCapability(
  paseoHome: string,
  expectedToken: string,
): Promise<void> {
  const filePath = coordinatorCapabilityPath(paseoHome);
  const current = await readCoordinatorCapability(paseoHome);
  if (current !== expectedToken) {
    return;
  }
  await rm(filePath, { force: true });
}
