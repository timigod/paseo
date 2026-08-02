import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findFleetHost, loadFleetConfig, resolveFleetConfigPath } from "./topology.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("fleet topology configuration", () => {
  it("prefers an exact normalized host ID over an earlier endpoint match", () => {
    const endpointShadow = {
      id: "builder-shadow",
      name: "Builder Shadow",
      endpoint: "builder-a",
      codeRoot: "/srv/code",
      hostnamePrefixes: ["builder-shadow"],
      capacity: 8,
    };
    const exactOwner = {
      ...endpointShadow,
      id: "Builder-A",
      name: "Builder A",
      endpoint: "builder-a.internal:6767",
    };

    expect(findFleetHost("builder-a", [endpointShadow, exactOwner])).toBe(exactOwner);
  });

  it("loads machine-local hosts and run defaults without repository policy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-config-"));
    cleanup.push(directory);
    const configPath = path.join(directory, "fleet.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        hosts: [
          {
            id: "builder-a",
            name: "Builder A",
            endpoint: "builder-a.internal:6767",
            codeRoot: "/srv/code",
            hostnamePrefixes: ["builder-a"],
            capacity: 8,
          },
        ],
        defaults: { provider: "provider-a", model: "model-a", thinking: "balanced" },
      }),
    );

    expect(loadFleetConfig({ PASEO_FLEET_CONFIG: configPath })).toEqual({
      version: 1,
      hosts: [
        {
          id: "builder-a",
          name: "Builder A",
          endpoint: "builder-a.internal:6767",
          codeRoot: "/srv/code",
          hostnamePrefixes: ["builder-a"],
          capacity: 8,
        },
      ],
      defaults: { provider: "provider-a", model: "model-a", thinking: "balanced" },
    });
  });

  it("uses $PASEO_HOME/fleet.json by default and fails closed when it is absent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-home-"));
    cleanup.push(directory);
    const env = { PASEO_HOME: directory };

    expect(resolveFleetConfigPath(env)).toBe(path.join(directory, "fleet.json"));
    expect(() => loadFleetConfig(env)).toThrow(
      expect.objectContaining({ code: "FLEET_CONFIG_UNAVAILABLE" }),
    );
  });

  it("rejects ambiguous host identifiers and endpoints", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-invalid-"));
    cleanup.push(directory);
    const configPath = path.join(directory, "fleet.json");
    const host = {
      id: "builder-a",
      name: "Builder A",
      endpoint: "builder.internal:6767",
      codeRoot: "/srv/code",
      hostnamePrefixes: ["builder-a"],
      capacity: 8,
    };
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        hosts: [host, { ...host, name: "Duplicate" }],
        defaults: { provider: "provider-a" },
      }),
    );

    expect(() => loadFleetConfig({ PASEO_FLEET_CONFIG: configPath })).toThrow(
      expect.objectContaining({ code: "FLEET_CONFIG_INVALID" }),
    );
  });
});
