import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const intent = {
  create: {
    type: "create_agent_request" as const,
    config: {
      provider: "codex" as const,
      cwd: "/srv/code/app",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    },
    initialPrompt: "repair the fleet",
    idempotencyKey: "create-1",
    workspaceSource: { kind: "directory" as const, path: "/srv/code/app" },
    labels: {},
  },
  prompt: "repair the fleet",
  waitTimeoutMs: 0,
  background: true,
};

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
      claimFleetAffinity({
        ...identity,
        affinity: { host: hostA, daemonId: "daemon-a", intent },
      }),
      claimFleetAffinity({
        ...identity,
        affinity: {
          host: hostB,
          daemonId: "daemon-b",
          intent: {
            ...intent,
            create: {
              ...intent.create,
              config: { ...intent.create.config, cwd: "/opt/code/app" },
            },
          },
        },
      }),
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
      affinity: {
        host: hostA,
        daemonId: "daemon-a",
        intent: {
          ...intent,
          create: { ...intent.create, idempotencyKey: "private-create-key" },
        },
      },
      env,
    });
    const directory = path.join(path.dirname(env.PASEO_FLEET_CONFIG!), "fleet-create-affinity");
    const [fileName] = await readdir(directory);
    const filePath = path.join(directory, fileName!);

    expect(await readFile(filePath, "utf8")).not.toContain("private-create-key");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("preserves the fully resolved create request across input drift", async () => {
    const env = await createEnv();
    const identity = { callerId: "caller-1", idempotencyKey: "create-1", env };
    await claimFleetAffinity({
      ...identity,
      affinity: { host: hostA, daemonId: "daemon-a", intent },
    });

    const replay = await loadFleetAffinity(identity);
    const { idempotencyKey: _idempotencyKey, ...persistedCreate } = intent.create;

    expect(replay).toEqual({
      host: hostA,
      daemonId: "daemon-a",
      intent: {
        ...intent,
        create: persistedCreate,
      },
    });
    expect(replay?.intent.create).toMatchObject({
      config: {
        cwd: "/srv/code/app",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "high",
      },
      initialPrompt: "repair the fleet",
      workspaceSource: { kind: "directory", path: "/srv/code/app" },
    });
  });

  it("fails closed when a version-1 affinity cannot reconstruct the create intent", async () => {
    const env = await createEnv();
    const identity = { callerId: "caller-1", idempotencyKey: "create-1", env };
    await claimFleetAffinity({
      ...identity,
      affinity: { host: hostA, daemonId: "daemon-a", intent },
    });
    const directory = path.join(path.dirname(env.PASEO_FLEET_CONFIG!), "fleet-create-affinity");
    const [fileName] = await readdir(directory);
    await writeFile(
      path.join(directory, fileName!),
      JSON.stringify({ version: 1, host: hostA, cwd: "/srv/code/app" }),
    );

    await expect(loadFleetAffinity(identity)).rejects.toThrow(
      "This fleet create key predates durable create intents and cannot be retried safely",
    );
  });
});
