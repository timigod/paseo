import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// This is a same-user routing capability for trusted local coordinator
// surfaces. Mode 0600 excludes other OS users, but it is not isolation from a
// deliberately hostile descendant running as the same user.
const LOCAL_COORDINATOR_ROUTING_CAPABILITY_FILENAME = "coordinator-auth-token";

export function localCoordinatorRoutingCapabilityPath(paseoHome: string): string {
  return join(paseoHome, LOCAL_COORDINATOR_ROUTING_CAPABILITY_FILENAME);
}

export async function writeLocalCoordinatorRoutingCapability(
  paseoHome: string,
  token: string,
): Promise<void> {
  const filePath = localCoordinatorRoutingCapabilityPath(paseoHome);
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

export async function readLocalCoordinatorRoutingCapability(
  paseoHome: string,
): Promise<string | null> {
  try {
    const token = (await readFile(localCoordinatorRoutingCapabilityPath(paseoHome), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function removeLocalCoordinatorRoutingCapability(
  paseoHome: string,
  expectedToken: string,
): Promise<void> {
  const filePath = localCoordinatorRoutingCapabilityPath(paseoHome);
  const current = await readLocalCoordinatorRoutingCapability(paseoHome);
  if (current !== expectedToken) {
    return;
  }
  await rm(filePath, { force: true });
}
