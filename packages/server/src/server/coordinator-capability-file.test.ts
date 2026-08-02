import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  coordinatorCapabilityPath,
  readCoordinatorCapability,
  removeCoordinatorCapability,
  writeCoordinatorCapability,
} from "./coordinator-capability-file.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("writes, rotates, and conditionally removes the coordinator capability as owner-only", async () => {
  const paseoHome = await mkdtemp(join(tmpdir(), "coordinator-capability-"));
  cleanupPaths.push(paseoHome);

  await writeCoordinatorCapability(paseoHome, "first-token");
  const capabilityPath = coordinatorCapabilityPath(paseoHome);
  expect(await readFile(capabilityPath, "utf8")).toBe("first-token");
  expect((await stat(capabilityPath)).mode & 0o777).toBe(0o600);

  await writeCoordinatorCapability(paseoHome, "second-token");
  await removeCoordinatorCapability(paseoHome, "first-token");
  expect(await readCoordinatorCapability(paseoHome)).toBe("second-token");

  await removeCoordinatorCapability(paseoHome, "second-token");
  expect(await readCoordinatorCapability(paseoHome)).toBeNull();
});
