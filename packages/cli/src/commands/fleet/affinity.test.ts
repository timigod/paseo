import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claimFleetAffinity, loadFleetAffinity } from "./affinity.js";

const directories: string[] = [];
const hostA = {
  id: "builder-a",
  name: "Builder A",
  endpoint: "builder-a.internal:6767",
  codeRoot: "/srv/code",
  hostnamePrefixes: ["builder-a"],
  capacity: 8,
};
const hostB = { ...hostA, id: "builder-b", name: "Builder B" };

async function createEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-affinity-"));
  directories.push(directory);
  return { PASEO_FLEET_CONFIG: path.join(directory, "fleet.json") };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("fleet create affinity", () => {
  it("preserves the first owner across concurrent claims and topology changes", async () => {
    const env = await createEnv();
    const identity = { callerId: "caller-1", idempotencyKey: "create-1", env };
    const [left, right] = await Promise.all([
      claimFleetAffinity({ ...identity, affinity: { host: hostA, cwd: "/srv/code/app" } }),
      claimFleetAffinity({ ...identity, affinity: { host: hostB, cwd: "/opt/code/app" } }),
    ]);
    const replay = await loadFleetAffinity(identity);

    expect(left).toEqual(right);
    expect(replay).toEqual(left);
    expect([hostA.id, hostB.id]).toContain(replay?.host.id);
  });

  it("stores no raw idempotency key and creates owner-only state", async () => {
    const env = await createEnv();
    await claimFleetAffinity({
      callerId: "caller-1",
      idempotencyKey: "private-create-key",
      affinity: { host: hostA, cwd: "/srv/code/app" },
      env,
    });
    const directory = path.join(path.dirname(env.PASEO_FLEET_CONFIG!), "fleet-create-affinity");
    const [fileName] = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    const filePath = path.join(directory, fileName!);

    expect(await readFile(filePath, "utf8")).not.toContain("private-create-key");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
