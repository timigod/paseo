import { describe, expect, test } from "vitest";
import {
  PASEO_MANAGED_AGENT_CONTEXT,
  applyManagedChildEnvOverlay,
  buildSelfNodeCommand,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  isManagedAgentContext,
  resolvePaseoNodeEnv,
} from "./paseo-env.js";

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_COORDINATOR_AUTH_TOKEN: "coordinator-token",
    PASEO_COORDINATOR_CAPABILITY: "coordinator-capability",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
    PASEO_SUPERVISOR_INCARNATION: "supervisor-incarnation",
    PASEO_SUPERVISOR_WORKER_TOKEN: "worker-token",
    PASEO_PASSWORD: "daemon-password",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "PASEO_SUPERVISOR_INCARNATION",
    "PASEO_SUPERVISOR_WORKER_TOKEN",
    "ELECTRON_NO_ATTACH_CONSOLE",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_SUPERVISOR_INCARNATION: "supervisor-incarnation",
      PASEO_SUPERVISOR_WORKER_TOKEN: "worker-token",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_COORDINATOR_AUTH_TOKEN: "overlay-token",
      PASEO_COORDINATOR_CAPABILITY: "overlay-capability",
      PASEO_PASSWORD: "overlay-password",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env[PASEO_MANAGED_AGENT_CONTEXT]).toBe("1");
    expect(env.PASEO_PASSWORD).toBeUndefined();
    expect(env.PASEO_COORDINATOR_AUTH_TOKEN).toBeUndefined();
    expect(env.PASEO_COORDINATOR_CAPABILITY).toBeUndefined();
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds provider-style overlays that cannot reintroduce coordinator authority", () => {
    const overlay = {
      PASEO_PASSWORD: "overlay-password",
      PASEO_COORDINATOR_AUTH_TOKEN: "overlay-token",
      PASEO_COORDINATOR_CAPABILITY: "overlay-capability",
    };

    applyManagedChildEnvOverlay(overlay);

    expect(overlay).toEqual({
      [PASEO_MANAGED_AGENT_CONTEXT]: "1",
      PASEO_PASSWORD: undefined,
      PASEO_COORDINATOR_AUTH_TOKEN: undefined,
      PASEO_COORDINATOR_CAPABILITY: undefined,
    });
    expect(isManagedAgentContext(overlay)).toBe(true);
    expect(isManagedAgentContext({ [PASEO_MANAGED_AGENT_CONTEXT]: "0" })).toBe(false);
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env[PASEO_MANAGED_AGENT_CONTEXT]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.PASEO_PASSWORD).toBeUndefined();
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });
});
