import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  localCoordinatorRoutingCapabilityPath,
  readLocalCoordinatorRoutingCapability,
  removeLocalCoordinatorRoutingCapability,
  writeLocalCoordinatorRoutingCapability,
} from "./coordinator-capability-file.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("writes and rotates the same-user local coordinator routing capability", async () => {
  const paseoHome = await mkdtemp(join(tmpdir(), "coordinator-capability-"));
  cleanupPaths.push(paseoHome);

  await writeLocalCoordinatorRoutingCapability(paseoHome, "first-token");
  const capabilityPath = localCoordinatorRoutingCapabilityPath(paseoHome);
  expect(await readFile(capabilityPath, "utf8")).toBe("first-token");
  expect((await stat(capabilityPath)).mode & 0o777).toBe(0o600);

  await writeLocalCoordinatorRoutingCapability(paseoHome, "second-token");
  await removeLocalCoordinatorRoutingCapability(paseoHome, "first-token");
  expect(await readLocalCoordinatorRoutingCapability(paseoHome)).toBe("second-token");

  await removeLocalCoordinatorRoutingCapability(paseoHome, "second-token");
  expect(await readLocalCoordinatorRoutingCapability(paseoHome)).toBeNull();
});
