import { describe, expect, test } from "vitest";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";

function createRecord(overrides?: Partial<StoredAgentRecord>): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id: "agent-record",
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    title: null,
    lastStatus: "idle",
    lastModeId: "plan",
    config: { modeId: "plan", model: "claude-3.5-sonnet" },
    persistence: {
      provider: "claude",
      sessionId: "session-123",
    },
    ...overrides,
  };
}

describe("persistence hooks", () => {
  test("extractTimestamps keeps runtime activity separate from metadata activity", () => {
    const record = createRecord({
      updatedAt: "2026-07-29T12:00:00.000Z",
      lastActivityAt: "2026-07-29T11:00:00.000Z",
      lastRuntimeActivityAt: "2026-07-29T09:00:00.000Z",
    });

    expect(extractTimestamps(record)).toMatchObject({
      updatedAt: new Date("2026-07-29T11:00:00.000Z"),
      lastRuntimeActivityAt: new Date("2026-07-29T09:00:00.000Z"),
    });
  });

  test("buildConfigOverrides carries systemPrompt and mcpServers", () => {
    const record = createRecord({
      title: "Voice agent (current)",
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        thinkingOptionId: "minimal",
        systemPrompt: "Use speak first.",
        mcpServers: {
          paseo: {
            type: "stdio",
            command: "node",
            args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
          },
        },
      },
    });

    expect(buildConfigOverrides(record)).toMatchObject({
      cwd: "/tmp/project",
      modeId: "plan",
      model: "gpt-5.4-mini",
      thinkingOptionId: "minimal",
      systemPrompt: "Use speak first.",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
        },
      },
    });
  });

  test("buildSessionConfig includes persisted systemPrompt and mcpServers", () => {
    const record = createRecord({
      provider: "codex",
      title: "Renamed title",
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        systemPrompt: "Confirm and speak first.",
        mcpServers: {
          paseo: {
            type: "stdio",
            command: "node",
            args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
          },
        },
      },
    });

    expect(buildSessionConfig(record)).toMatchObject({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "plan",
      model: "gpt-5.4-mini",
      systemPrompt: "Confirm and speak first.",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
        },
      },
    });
  });

  test("buildConfigOverrides drops persisted internal paseo MCP server", () => {
    const record = createRecord({
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
          },
          custom: {
            type: "stdio",
            command: "custom-mcp",
          },
        },
      },
    });

    expect(buildConfigOverrides(record).mcpServers).toEqual({
      custom: {
        type: "stdio",
        command: "custom-mcp",
      },
    });
  });

  test("buildConfigOverrides preserves user-provided paseo MCP server", () => {
    const record = createRecord({
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        mcpServers: {
          paseo: {
            type: "http",
            url: "https://example.com/custom-paseo",
          },
        },
      },
    });

    expect(buildConfigOverrides(record).mcpServers).toEqual({
      paseo: {
        type: "http",
        url: "https://example.com/custom-paseo",
      },
    });
  });

  test("buildSessionConfig accepts providers from the canonical manifest", () => {
    const record = createRecord({
      provider: "claude",
      persistence: {
        provider: "claude",
        sessionId: "session-123",
      },
      config: {},
    });

    expect(buildSessionConfig(record)).toMatchObject({
      provider: "claude",
      cwd: "/tmp/project",
    });
  });

  test("buildSessionConfig skips records whose provider is missing from the registry", () => {
    const record = createRecord({
      id: "agent-missing-provider",
      provider: "zai",
    });

    expect(
      buildSessionConfig(record, {
        validProviders: ["claude", "codex"],
      }),
    ).toBeNull();
  });

  test("toAgentPersistenceHandle rejects handles for unavailable providers", () => {
    const handle = toAgentPersistenceHandle(["claude", "codex"], {
      provider: "gemini",
      sessionId: "session-123",
    });

    expect(handle).toBeNull();
  });
});
