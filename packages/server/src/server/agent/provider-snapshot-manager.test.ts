import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  FetchCatalogOptions,
  ResolveAgentCreateConfigInput,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
  resolveSnapshotCwd,
} from "./provider-snapshot-manager.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./providers/opencode/test-utils/test-opencode-harness.js";
import type { OpenCodeServerAcquisition } from "./providers/opencode/server-manager.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;
const TEST_REFRESH_TIMEOUT_MS = 120_000;

// Builds an AgentClient that can be injected via the public extraClients option.
// extraClients is the only injection surface the manager exposes for tests.
function createExtraClient(
  provider: AgentProvider,
  overrides: Partial<AgentClient> = {},
): AgentClient {
  return {
    provider,
    capabilities: TEST_CAPABILITIES,
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async fetchCatalog(_options: FetchCatalogOptions) {
      return { models: [] as AgentModelDefinition[], modes: [] as AgentMode[] };
    },
    async isAvailable() {
      return false;
    },
    ...overrides,
  } satisfies AgentClient;
}

async function withEnv(key: string, value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("ProviderSnapshotManager public surface", () => {
  test("listRegisteredProviderIds includes the built-in providers", () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      const ids = manager.listRegisteredProviderIds();
      expect(ids).toEqual(
        expect.arrayContaining(["claude", "codex", "opencode", "copilot", "pi", "omp"]),
      );
    } finally {
      manager.destroy();
    }
  });

  test("hasProvider reflects the built-in set and providerOverrides additions", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      },
    });
    try {
      expect(manager.hasProvider("claude")).toBe(true);
      expect(manager.hasProvider("zai-claude")).toBe(true);
      expect(manager.hasProvider("not-a-provider" as AgentProvider)).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("getProviderLabel returns the override label when provided", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "qwen-codex": { extends: "codex", label: "Qwen Code", enabled: true },
      },
    });
    try {
      expect(manager.getProviderLabel("qwen-codex")).toBe("Qwen Code");
      expect(manager.getProviderLabel("claude")).toBe("Claude");
    } finally {
      manager.destroy();
    }
  });

  test("getSnapshot returns loading entries for built-in providers before warmup", () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      const snapshot = manager.getSnapshot("/tmp/project");
      const claude = snapshot.find((entry) => entry.provider === "claude");
      const codex = snapshot.find((entry) => entry.provider === "codex");
      expect(claude?.status).toBe("loading");
      expect(claude?.label).toBe("Claude");
      expect(claude?.defaultModeId).toBe("auto");
      expect(codex?.defaultModeId).toBe("auto-review");
    } finally {
      manager.destroy();
    }
  });

  test("observational and Claude-only reads leave OpenCode cold", async () => {
    const cwd = "/tmp/project";
    const fetchClaudeCatalog = vi.fn(async () => ({
      models: [{ provider: "claude", id: "claude-opus-4.6", label: "Claude Opus 4.6" }],
      modes: [] as AgentMode[],
    }));
    const isOpenCodeAvailable = vi.fn(async () => true);
    const fetchOpenCodeCatalog = vi.fn(async () => ({
      models: [{ provider: "opencode", id: "openai/gpt-5.4", label: "GPT 5.4" }],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        claude: createExtraClient("claude", {
          isAvailable: async () => true,
          fetchCatalog: fetchClaudeCatalog,
        }),
        opencode: createExtraClient("opencode", {
          isAvailable: isOpenCodeAvailable,
          fetchCatalog: fetchOpenCodeCatalog,
        }),
      },
    });

    try {
      const observed = manager.getSnapshot(cwd);
      expect(observed.find((entry) => entry.provider === "opencode")).toMatchObject({
        status: "loading",
        label: "OpenCode",
      });

      const listed = await manager.listProviders({ cwd, wait: true });
      expect(listed.find((entry) => entry.provider === "opencode")?.status).toBe("loading");

      await expect(
        manager.listProviders({ cwd, providers: ["claude"], wait: true }),
      ).resolves.toMatchObject([{ provider: "claude", status: "ready" }]);
      expect(manager.getSnapshot(cwd).find((entry) => entry.provider === "opencode")?.status).toBe(
        "loading",
      );
      expect(fetchClaudeCatalog).toHaveBeenCalledTimes(1);
      expect(isOpenCodeAvailable).not.toHaveBeenCalled();
      expect(fetchOpenCodeCatalog).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("providerOverrides with enabled:false marks the provider as unavailable without probing", async () => {
    const isAvailable = vi.fn(async () => true);
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, fetchCatalog }),
      },
    });
    try {
      const entries = await manager.listProviders({ cwd: "/tmp/project", wait: true });
      const codex = entries.find((entry) => entry.provider === "codex");
      expect(codex).toMatchObject({ provider: "codex", enabled: false, status: "unavailable" });
      expect(isAvailable).not.toHaveBeenCalled();
      expect(fetchCatalog).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("extraClients with isAvailable=false routes to unavailable without fetching", async () => {
    const isAvailable = vi.fn().mockResolvedValue(false);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: { codex: createExtraClient("codex", { isAvailable }) },
    });
    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(entry.provider).toBe("codex");
      expect(entry.status).toBe("unavailable");
      expect(isAvailable).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("wait:true returns a warm provider without refreshing it", async () => {
    const cwd = "/tmp/project";
    const isAvailable = vi.fn(async () => true);
    const fetchCatalog = vi.fn(async () => ({
      models: [
        {
          provider: "codex",
          id: "gpt-5.4-mini",
          label: "GPT 5.4 Mini",
        },
      ] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, fetchCatalog }),
      },
    });
    const listener = vi.fn();
    manager.on("change", listener);
    try {
      const [first] = await manager.listProviders({ cwd, providers: ["codex"], wait: true });
      expect(first).toMatchObject({ provider: "codex", status: "ready" });
      expect(isAvailable).toHaveBeenCalledTimes(1);
      expect(fetchCatalog).toHaveBeenCalledTimes(1);

      listener.mockClear();
      const [second] = await manager.listProviders({ cwd, providers: ["codex"], wait: true });

      expect(second).toEqual(first);
      expect(isAvailable).toHaveBeenCalledTimes(1);
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("ready snapshots publish the catalog's capability-aware default mode", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [],
            modes: [{ id: "default", label: "Default", description: "Ask before running tools" }],
            defaultModeId: "default",
          }),
        }),
      },
    });

    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });

      expect(entry).toMatchObject({ status: "ready", defaultModeId: "default" });
    } finally {
      manager.destroy();
    }
  });

  test("explicit refresh re-probes only the requested warm provider", async () => {
    const cwd = "/tmp/project";
    const isAvailableCodex = vi.fn(async () => true);
    const fetchCodexCatalog = vi.fn(async () => ({
      models: [
        {
          provider: "codex",
          id: "gpt-5.4-mini",
          label: "GPT 5.4 Mini",
        },
      ] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const isAvailableClaude = vi.fn(async () => true);
    const fetchClaudeCatalog = vi.fn(async () => ({
      models: [
        {
          provider: "claude",
          id: "claude-opus-4.5",
          label: "Claude Opus 4.5",
        },
      ] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: isAvailableCodex,
          fetchCatalog: fetchCodexCatalog,
        }),
        claude: createExtraClient("claude", {
          isAvailable: isAvailableClaude,
          fetchCatalog: fetchClaudeCatalog,
        }),
      },
    });
    try {
      await manager.listProviders({ cwd, providers: ["codex", "claude"], wait: true });
      await manager.refreshSnapshotForCwd({ cwd, providers: ["codex"] });

      expect(isAvailableCodex).toHaveBeenCalledTimes(2);
      expect(fetchCodexCatalog).toHaveBeenCalledTimes(2);
      expect(isAvailableClaude).toHaveBeenCalledTimes(1);
      expect(fetchClaudeCatalog).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("refreshTimeoutMs option overrides the default and yields a timeout error", async () => {
    // never-resolving isAvailable forces the timeout path
    const isAvailable = vi.fn(() => new Promise<boolean>(() => {}));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: { codex: createExtraClient("codex", { isAvailable }) },
    });
    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(entry.provider).toBe("codex");
      expect(entry.status).toBe("error");
      expect(entry.error).toMatch(/after 1ms/);
    } finally {
      manager.destroy();
    }
  });

  test("PASEO_PROVIDER_REFRESH_TIMEOUT_MS env var is honored when no option is given", async () => {
    vi.stubEnv("PASEO_PROVIDER_REFRESH_TIMEOUT_MS", "1");
    const isAvailable = vi.fn(() => new Promise<boolean>(() => {}));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: { codex: createExtraClient("codex", { isAvailable }) },
    });
    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(entry.status).toBe("error");
      expect(entry.error).toMatch(/after 1ms/);
    } finally {
      manager.destroy();
      vi.unstubAllEnvs();
    }
  });

  test("PASEO_PROVIDER_REFRESH_TIMEOUT_MS env var is ignored when option is provided", async () => {
    vi.stubEnv("PASEO_PROVIDER_REFRESH_TIMEOUT_MS", "1");
    const isAvailable = vi.fn(() => new Promise<boolean>(() => {}));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 5,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: { codex: createExtraClient("codex", { isAvailable }) },
    });
    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(entry.status).toBe("error");
      // explicit option (5) wins over env var (1)
      expect(entry.error).toMatch(/after 5ms/);
    } finally {
      manager.destroy();
      vi.unstubAllEnvs();
    }
  });

  test("listProviders returns an entry per registered provider", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const entries = await manager.listProviders({ cwd: "/tmp/project", wait: true });
      const providers = entries.map((entry) => entry.provider).sort();
      expect(providers).toEqual(["claude", "codex", "copilot", "omp", "opencode", "pi"]);
      for (const entry of entries) {
        expect(entry.enabled).toBe(false);
        expect(entry.status).toBe("unavailable");
      }
    } finally {
      manager.destroy();
    }
  });

  test("getProvider throws when the provider is not configured", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      await expect(
        manager.getProvider({
          cwd: "/tmp/project",
          provider: "not-a-provider" as AgentProvider,
          wait: true,
        }),
      ).rejects.toThrow(/not configured/);
    } finally {
      manager.destroy();
    }
  });

  test("listModels rejects when the provider is disabled", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      await expect(
        manager.listModels({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).rejects.toThrow(/disabled/);
    } finally {
      manager.destroy();
    }
  });

  test("listModes rejects when the provider is disabled", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      await expect(
        manager.listModes({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).rejects.toThrow(/disabled/);
    } finally {
      manager.destroy();
    }
  });

  test("resolveDefaultModel returns the requested model verbatim when provided", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      const id = await manager.resolveDefaultModel({
        provider: "codex",
        requestedModel: "gpt-5.4",
        cwd: "/tmp/project",
      });
      expect(id).toBe("gpt-5.4");
    } finally {
      manager.destroy();
    }
  });

  test("resolveDefaultModel returns undefined when the provider is disabled and no override is given", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      const id = await manager.resolveDefaultModel({ provider: "codex", cwd: "/tmp/project" });
      expect(id).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic returns the diagnostic from the injected client and appends snapshot models/status", async () => {
    const getDiagnostic = vi.fn(async () => ({ diagnostic: "codex is ready" }));
    const client = createExtraClient("codex", { getDiagnostic });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).toContain("codex is ready");
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
      expect(getDiagnostic).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic force-refreshes the snapshot and appends models/status", async () => {
    const catalogModels: AgentModelDefinition[] = [
      { provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
    ];
    const catalogModes: AgentMode[] = [{ id: "agent", label: "Agent" }];
    const fetchCatalog = vi.fn(async () => ({
      models: catalogModels,
      modes: catalogModes,
    }));
    const client = createExtraClient("codex", {
      isAvailable: async () => true,
      fetchCatalog,
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      expect(fetchCatalog.mock.calls[0]?.[0]).toMatchObject({ scope: "global", force: true });
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic falls back to a default message when the client has no getDiagnostic and appends snapshot models/status", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: createExtraClient("codex") },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).toMatch(/no diagnostic/i);
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic materializes the client and proceeds for an unmaterialized configured provider", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      isDev: true,
      extraClients: {},
    });
    try {
      const result = await manager.getProviderDiagnostic("mock");
      expect(result.provider).toBe("mock");
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic turns provider diagnostic failures into diagnostic text", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }],
            modes: [] as AgentMode[],
          }),
          getDiagnostic: async () => {
            throw new Error("diagnostic probe exploded");
          },
        }),
      },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.diagnostic).toContain("Error: diagnostic probe exploded");
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic starts provider diagnostics before waiting for snapshot refresh", async () => {
    vi.useFakeTimers();
    let diagnosticStarted = false;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => new Promise(() => {}),
          getDiagnostic: async () => {
            diagnosticStarted = true;
            return { diagnostic: "codex diagnostics available" };
          },
        }),
      },
    });
    try {
      const diagnosticRequest = manager.getProviderDiagnostic("codex");
      expect(diagnosticStarted).toBe(true);

      const diagnosticOrBlocked = Promise.race([
        diagnosticRequest.then(() => ({ type: "diagnostic" as const })),
        new Promise<{ type: "blocked" }>((finish) => {
          setTimeout(() => finish({ type: "blocked" }), 1);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(diagnosticOrBlocked).resolves.toEqual({ type: "blocked" });

      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS - 1);
      const result = await diagnosticRequest;
      expect(result.diagnostic).toContain("codex diagnostics available");
      expect(result.diagnostic).toContain(
        `Status: Error: Timed out refreshing Codex after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("getProviderDiagnostic starts snapshot refresh even when provider diagnostics hang", async () => {
    vi.useFakeTimers();
    let diagnosticStarted = false;
    let snapshotStarted = false;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => {
            snapshotStarted = true;
            return new Promise(() => {});
          },
          getDiagnostic: async () => {
            diagnosticStarted = true;
            return new Promise(() => {});
          },
        }),
      },
    });
    try {
      const diagnosticRequest = manager.getProviderDiagnostic("codex");
      await vi.advanceTimersByTimeAsync(0);

      expect(diagnosticStarted).toBe(true);
      expect(snapshotStarted).toBe(true);

      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);
      const result = await diagnosticRequest;
      expect(result.diagnostic).toContain(
        `Error: Timed out collecting Codex diagnostic after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
      expect(result.diagnostic).toContain(
        `Status: Error: Timed out refreshing Codex after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("getProviderDiagnostic reports provider diagnostic timeout while preserving snapshot details", async () => {
    vi.useFakeTimers();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }],
            modes: [] as AgentMode[],
          }),
          getDiagnostic: async () => new Promise(() => {}),
        }),
      },
    });
    try {
      const diagnosticRequest = manager.getProviderDiagnostic("codex");
      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);

      const result = await diagnosticRequest;
      expect(result.diagnostic).toContain(
        `Error: Timed out collecting Codex diagnostic after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("getProviderDiagnostic reports a stuck catalog refresh inside the diagnostic", async () => {
    await withEnv("PASEO_ENABLE_MOCK_SLOW", "true", async () => {
      vi.useFakeTimers();
      const manager = new ProviderSnapshotManager({
        logger: createTestLogger(),
        isDev: true,
        refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      });
      try {
        const diagnosticRequest = manager.getProviderDiagnostic("mock-slow");
        await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);

        const result = await diagnosticRequest;
        expect(result.provider).toBe("mock-slow");
        expect(result.diagnostic).toContain("Mock slow provider");
        expect(result.diagnostic).toContain("Models: —");
        expect(result.diagnostic).toContain(
          `Status: Error: Timed out refreshing Mock Slow Provider after ${TEST_REFRESH_TIMEOUT_MS}ms`,
        );
      } finally {
        manager.destroy();
        vi.useRealTimers();
      }
    });
  });

  test("getProviderDiagnostic returns an error diagnostic for an unknown provider", async () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      await expect(manager.getProviderDiagnostic("unknown-provider" as AgentProvider)).resolves
        .toMatchInlineSnapshot(`
          {
            "diagnostic": "unknown-provider
            Error: Provider unknown-provider is not configured",
            "provider": "unknown-provider",
          }
        `);
    } finally {
      manager.destroy();
    }
  });

  test("getAgentManagerProviderState exposes extraClients verbatim", () => {
    const codexClient = createExtraClient("codex");
    const claudeClient = createExtraClient("claude");
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { opencode: { enabled: false }, copilot: { enabled: false } },
      extraClients: { codex: codexClient, claude: claudeClient },
    });
    try {
      const state = manager.getAgentManagerProviderState();
      expect(state.clients.codex).toBe(codexClient);
      expect(state.clients.claude).toBe(claudeClient);
      expect(state.providerDefinitions.opencode).toMatchObject({ enabled: false });
      expect(state.providerDefinitions.codex).toMatchObject({ enabled: true });
    } finally {
      manager.destroy();
    }
  });

  test("resolveCreateConfig reduces a managed parent to provider mode and unattended data", async () => {
    const resolverInputs: ResolveAgentCreateConfigInput[] = [];
    const childModes: AgentMode[] = [
      { id: "child-unattended", label: "Child", isUnattended: true },
    ];
    const parentModes: AgentMode[] = [
      { id: "parent-unattended", label: "Parent", isUnattended: true },
    ];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes: childModes };
          },
          async resolveCreateConfig(input) {
            resolverInputs.push(input);
            return {
              modeId: input.parent?.isUnattended ? "child-unattended" : undefined,
              featureValues: undefined,
            };
          },
        }),
        claude: createExtraClient("claude", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes: parentModes };
          },
          isCreateConfigUnattended(input) {
            return input.modeId === "parent-unattended";
          },
        }),
      },
    });
    try {
      const parent = {
        id: "parent-agent",
        provider: "claude",
        currentModeId: "parent-unattended",
        availableModes: parentModes,
        config: { provider: "claude", cwd: "/tmp/project" },
      } as ManagedAgent;

      const resolved = await manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "codex",
        requestedMode: undefined,
        featureValues: undefined,
        parent,
        unattended: false,
      });

      expect(resolved).toEqual({ modeId: "child-unattended", featureValues: undefined });
      expect(resolverInputs).toEqual([
        {
          provider: "codex",
          requestedMode: undefined,
          featureValues: undefined,
          parent: {
            provider: "claude",
            modeId: "parent-unattended",
            isUnattended: true,
          },
          unattended: true,
          availableModes: childModes,
        },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("resolveCreateConfig passes explicit unattended intent to provider policy", async () => {
    const resolverInputs: ResolveAgentCreateConfigInput[] = [];
    const modes: AgentMode[] = [{ id: "worker", label: "Worker", isUnattended: true }];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes };
          },
          async resolveCreateConfig(input) {
            resolverInputs.push(input);
            return {
              modeId: input.unattended ? "worker" : undefined,
              featureValues: undefined,
            };
          },
        }),
      },
    });
    try {
      const resolved = await manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "codex",
        requestedMode: undefined,
        featureValues: { fast_mode: true },
        parent: null,
        unattended: true,
      });

      expect(resolved).toEqual({ modeId: "worker", featureValues: undefined });
      expect(resolverInputs).toEqual([
        {
          provider: "codex",
          requestedMode: undefined,
          featureValues: { fast_mode: true },
          parent: null,
          unattended: true,
          availableModes: modes,
        },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("keeps a provider usable while dynamic modes are unknown and preserves explicit modes", async () => {
    const fetchCatalog = vi.fn(async () => ({
      models: [{ provider: "codex", id: "gpt-5.4", label: "GPT 5.4" }],
      modes: [] as AgentMode[],
      modeDiscoveryError: "OpenCode app.agents timed out after 250ms",
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });

    try {
      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: undefined,
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).resolves.toEqual({ modeId: undefined, featureValues: undefined });
      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: "custom-mode",
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).resolves.toEqual({ modeId: "custom-mode", featureValues: undefined });

      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: false,
      });
      expect(entry).toMatchObject({
        status: "ready",
        models: [{ id: "gpt-5.4" }],
        error: "OpenCode app.agents timed out after 250ms",
      });
      expect(entry.modes).toBeUndefined();
      await expect(
        manager.listModes({ cwd: "/tmp/project", provider: "codex", wait: false }),
      ).resolves.toBeUndefined();
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("degrades real OpenCode mode discovery before the manager catalog deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.providerListResponse = {
      data: {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: { "gpt-5.4": { name: "GPT 5.4" } },
          },
        ],
      },
    };
    openCodeClient.appAgentsImplementation = async (_parameters, options) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      return await new Promise((_finish, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("app.agents aborted")), {
          once: true,
        });
      });
    };
    runtime.enqueueClient(openCodeClient);
    const openCodeAgentClient = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    vi.spyOn(openCodeAgentClient, "isAvailable").mockResolvedValue(true);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1_000,
      extraClients: {
        opencode: openCodeAgentClient,
      },
    });
    const entryPromise = manager.getProvider({
      cwd: "/tmp/project",
      provider: "opencode",
      wait: true,
    });

    try {
      await vi.waitFor(() => expect(openCodeClient.calls.appAgents).toHaveLength(1), {
        interval: 1,
        timeout: 100,
      });
      await vi.advanceTimersByTimeAsync(Math.max(0, 975 - Date.now()));
      const earlyResult = await Promise.race([
        entryPromise,
        Promise.resolve({ status: "pending" as const }),
      ]);

      await vi.advanceTimersByTimeAsync(Math.max(0, 1_000 - Date.now()));
      await entryPromise.catch(() => undefined);

      expect(earlyResult).toMatchObject({
        provider: "opencode",
        status: "ready",
        models: [{ id: "openai/gpt-5.4" }],
        error: expect.stringContaining("app.agents"),
      });
      expect("modes" in earlyResult ? earlyResult.modes : undefined).toBeUndefined();
      expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("does not publish a late catalog after timing out during real OpenCode acquisition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtime = new TestOpenCodeHarness();
    const acquireCurrent = runtime.acquireCurrent.bind(runtime);
    let resolveAcquisition!: (acquisition: OpenCodeServerAcquisition) => void;
    const pendingAcquisition = new Promise<OpenCodeServerAcquisition>((finish) => {
      resolveAcquisition = finish;
    });
    vi.spyOn(runtime, "acquireCurrent").mockReturnValue(pendingAcquisition);
    const openCodeAgentClient = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    vi.spyOn(openCodeAgentClient, "isAvailable").mockResolvedValue(true);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 250,
      extraClients: {
        opencode: openCodeAgentClient,
      },
    });
    const entryPromise = manager.getProvider({
      cwd: "/tmp/project",
      provider: "opencode",
      wait: true,
    });

    try {
      await vi.waitFor(() => expect(runtime.acquireCurrent).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(250);
      const timedOutEntry = await entryPromise;

      expect(timedOutEntry).toMatchObject({
        provider: "opencode",
        status: "error",
        error: "OpenCode server acquisition timed out within the 250ms catalog budget",
      });
      expect(timedOutEntry.modes).toBeUndefined();
      expect(runtime.clientCreations).toEqual([]);

      resolveAcquisition(await acquireCurrent());
      await vi.waitFor(() => {
        expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
      });
      const settledEntry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "opencode",
        wait: false,
      });
      expect(settledEntry).toEqual(timedOutEntry);
      expect(runtime.clientCreations).toEqual([]);
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("unattended create without a mode refreshes one cached transient provider error and succeeds", async () => {
    const fetchCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error("cold catalog failure"))
      .mockResolvedValueOnce({ models: [], modes: [] });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });

    try {
      await expect(
        manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).resolves.toMatchObject({ status: "error", error: "cold catalog failure" });

      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: undefined,
          featureValues: undefined,
          parent: null,
          unattended: true,
        }),
      ).resolves.toEqual({ modeId: undefined, featureValues: undefined });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
      expect(fetchCatalog.mock.calls[1]?.[0]).toMatchObject({ force: true });
    } finally {
      manager.destroy();
    }
  });

  test("concurrent unattended creates share one recovery load after a cached error", async () => {
    let finishRecovery!: (catalog: { models: AgentModelDefinition[]; modes: AgentMode[] }) => void;
    const recoveryCatalog = new Promise<{
      models: AgentModelDefinition[];
      modes: AgentMode[];
    }>((finish) => {
      finishRecovery = finish;
    });
    const fetchCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error("cold catalog failure"))
      .mockImplementationOnce(async () => await recoveryCatalog);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });

    try {
      await manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true });
      const createInput = {
        cwd: "/tmp/project",
        provider: "codex" as const,
        requestedMode: undefined,
        featureValues: undefined,
        parent: null,
        unattended: true,
      };
      const firstCreate = manager.resolveCreateConfig(createInput);
      const secondCreate = manager.resolveCreateConfig(createInput);

      await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2));
      finishRecovery({ models: [], modes: [] });

      await expect(Promise.all([firstCreate, secondCreate])).resolves.toEqual([
        { modeId: undefined, featureValues: undefined },
        { modeId: undefined, featureValues: undefined },
      ]);
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
    } finally {
      manager.destroy();
    }
  });

  test("each unattended create performs at most one recovery and reports the latest error", async () => {
    const fetchCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error("initial catalog failure"))
      .mockRejectedValueOnce(new Error("first recovery failure"))
      .mockRejectedValueOnce(new Error("second recovery failure"));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });
    const createInput = {
      cwd: "/tmp/project",
      provider: "codex" as const,
      requestedMode: undefined,
      featureValues: undefined,
      parent: null,
      unattended: true,
    };

    try {
      await manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true });
      await expect(manager.resolveCreateConfig(createInput)).rejects.toThrow(
        "first recovery failure",
      );
      expect(fetchCatalog).toHaveBeenCalledTimes(2);

      await expect(manager.resolveCreateConfig(createInput)).rejects.toThrow(
        "second recovery failure",
      );
      expect(fetchCatalog).toHaveBeenCalledTimes(3);
    } finally {
      manager.destroy();
    }
  });

  test.each([
    { label: "disabled", enabled: false, available: true },
    { label: "unavailable", enabled: true, available: false },
  ])("does not retry an $label provider during create", async ({ enabled, available }) => {
    const isAvailable = vi.fn(async () => available);
    const fetchCatalog = vi.fn(async () => ({ models: [], modes: [] }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled } },
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, fetchCatalog }),
      },
    });

    try {
      await manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true });
      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: undefined,
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).rejects.toThrow(enabled ? "not available" : "disabled");
      expect(isAvailable).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(fetchCatalog).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("explicit OpenCode create resolves immediately while app.agents discovery hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.providerListResponse = {
      data: {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: { "gpt-5.6-terra": { name: "GPT 5.6 Terra" } },
          },
        ],
      },
    };
    openCodeClient.appAgentsImplementation = async (_parameters, options) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      return await new Promise((_finish, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("app.agents aborted")), {
          once: true,
        });
      });
    };
    runtime.enqueueClient(openCodeClient);
    const openCodeAgentClient = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    vi.spyOn(openCodeAgentClient, "isAvailable").mockResolvedValue(true);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 60_000,
      extraClients: {
        opencode: openCodeAgentClient,
      },
    });

    try {
      const createPromise = manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "opencode",
        requestedMode: "orchestrator",
        featureValues: undefined,
        parent: null,
        unattended: false,
      });
      const createdOrBlocked = Promise.race([
        createPromise.then((resolved) => ({ type: "created" as const, resolved })),
        new Promise<{ type: "blocked" }>((finish) => {
          setTimeout(() => finish({ type: "blocked" }), 5);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5);
      // The requested runtime comes back verbatim: no wait on the 60000ms
      // catalog budget and no substitution with the provider default mode.
      await expect(createdOrBlocked).resolves.toEqual({
        type: "created",
        resolved: { modeId: "orchestrator", featureValues: undefined },
      });

      // Discovery still runs in the background, degrades at its own budget,
      // and releases the acquired server instead of leaking it.
      await vi.waitFor(() => expect(openCodeClient.calls.appAgents).toHaveLength(1), {
        interval: 1,
        timeout: 100,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "opencode",
        wait: false,
      });
      expect(entry).toMatchObject({
        status: "ready",
        models: [{ id: "openai/gpt-5.6-terra" }],
        error: expect.stringContaining("app.agents"),
      });
      expect(entry.modes).toBeUndefined();
      expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("explicit mode create succeeds without a recovery refresh after discovery failed", async () => {
    const fetchCatalog = vi.fn().mockRejectedValue(new Error("cold catalog failure"));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });

    try {
      await expect(
        manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).resolves.toMatchObject({ status: "error", error: "cold catalog failure" });

      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: "custom-mode",
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).resolves.toEqual({ modeId: "custom-mode", featureValues: undefined });
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("explicit mode create validates fail-closed against a ready catalog", async () => {
    const modes: AgentMode[] = [
      { id: "build", label: "Build" },
      { id: "plan", label: "Plan" },
    ];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({ models: [] as AgentModelDefinition[], modes }),
        }),
      },
    });

    try {
      await manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true });
      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: "plan",
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).resolves.toEqual({ modeId: "plan", featureValues: undefined });
      await expect(
        manager.resolveCreateConfig({
          cwd: "/tmp/project",
          provider: "codex",
          requestedMode: "made-up-mode",
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).rejects.toThrow("Invalid mode 'made-up-mode'");
    } finally {
      manager.destroy();
    }
  });

  test("omitted-mode create without parent or unattended intent does not wait on a hanging catalog", async () => {
    let finishCatalog!: (catalog: { models: AgentModelDefinition[]; modes: AgentMode[] }) => void;
    const fetchCatalog = vi.fn(
      async () =>
        await new Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>((finish) => {
          finishCatalog = finish;
        }),
    );
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });
    const createInput = {
      cwd: "/tmp/project",
      provider: "codex" as const,
      requestedMode: undefined,
      featureValues: undefined,
      parent: null,
      unattended: false,
    };

    try {
      await expect(manager.resolveCreateConfig(createInput)).resolves.toEqual({
        modeId: undefined,
        featureValues: undefined,
      });
      await expect(manager.resolveCreateConfig(createInput)).resolves.toEqual({
        modeId: undefined,
        featureValues: undefined,
      });
      // Both creates share the single background discovery load.
      await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1));
    } finally {
      manager.destroy();
    }
    // A late catalog resolution after destroy must be inert.
    finishCatalog({ models: [], modes: [] });
    await new Promise((finish) => setImmediate(finish));
  });

  test("unattended create without an explicit mode still waits for mode discovery", async () => {
    vi.useFakeTimers();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => new Promise(() => {}),
        }),
      },
    });

    try {
      const createPromise = manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "codex",
        requestedMode: undefined,
        featureValues: undefined,
        parent: null,
        unattended: true,
      });
      const createdOrBlocked = Promise.race([
        createPromise.then(() => ({ type: "created" as const })),
        new Promise<{ type: "blocked" }>((finish) => {
          setTimeout(() => finish({ type: "blocked" }), 5);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5);
      await expect(createdOrBlocked).resolves.toEqual({ type: "blocked" });

      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);
      await expect(createPromise).rejects.toThrow(
        `Timed out refreshing Codex after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("treats an OpenCode parent with auto accept as unattended when resolving an explicit child mode", async () => {
    const openCode = new OpenCodeAgentClient(createTestLogger());
    const modes: AgentMode[] = [
      { id: "build", label: "Build" },
      { id: "base", label: "Base" },
      { id: "orchestrator", label: "Orchestrator" },
    ];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        opencode: createExtraClient("opencode", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes };
          },
          resolveCreateConfig: openCode.resolveCreateConfig.bind(openCode),
          isCreateConfigUnattended: openCode.isCreateConfigUnattended.bind(openCode),
        }),
      },
    });
    try {
      const parent = {
        id: "parent-agent",
        provider: "opencode",
        currentModeId: "orchestrator",
        availableModes: modes,
        config: {
          provider: "opencode",
          cwd: "/tmp/project",
          featureValues: { auto_accept: true },
        },
      } as ManagedAgent;

      const resolved = await manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "opencode",
        requestedMode: "base",
        featureValues: undefined,
        parent,
        unattended: false,
      });

      expect(resolved).toEqual({ modeId: "base", featureValues: { auto_accept: true } });
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager applyMutableProviderConfig", () => {
  test("adds a derived provider and includes it in subsequent reads", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      expect(manager.hasProvider("zai-claude")).toBe(false);

      const state = manager.applyMutableProviderConfig({
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      });

      expect(manager.hasProvider("zai-claude")).toBe(true);
      expect(state.providerDefinitions["zai-claude"]).toMatchObject({ enabled: true });
      expect(manager.listRegisteredProviderIds()).toContain("zai-claude");
      expect(manager.getSnapshot().find((entry) => entry.provider === "zai-claude")?.source).toBe(
        "custom",
      );
    } finally {
      manager.destroy();
    }
  });

  test("removes startup provider overrides from the live registry", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      },
    });
    try {
      expect(manager.hasProvider("zai-claude")).toBe(true);

      const state = manager.applyMutableProviderConfig({}, { removeProviders: ["zai-claude"] });

      expect(manager.hasProvider("zai-claude")).toBe(false);
      expect(state.providerDefinitions["zai-claude"]).toBeUndefined();
      expect(manager.getSnapshot().some((entry) => entry.provider === "zai-claude")).toBe(false);

      manager.applyMutableProviderConfig({ codex: { enabled: false } });
      expect(manager.hasProvider("zai-claude")).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("drops disabled built-in providers from clients while preserving providerDefinitions", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: true },
        codex: { enabled: true },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const before = manager.getAgentManagerProviderState();
      expect(before.providerDefinitions.copilot).toMatchObject({ enabled: false });
      expect(before.clients.copilot).toBeUndefined();

      const state = manager.applyMutableProviderConfig({ codex: { enabled: false } });
      expect(state.providerDefinitions.codex).toMatchObject({ enabled: false });
      expect(state.clients.codex).toBeUndefined();
      expect(state.providerDefinitions.copilot).toMatchObject({ enabled: false });
      expect(state.clients.copilot).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  test("fires a change event on every primed snapshot cwd after applyMutableProviderConfig", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const listener = vi.fn();
      manager.on("change", listener);

      // Prime two distinct cwd snapshots. resolve() makes the keys platform-
      // native so Windows ("D:\\tmp\\...") matches the assertion below.
      const cwdA = resolve("/tmp/project-a");
      const cwdB = resolve("/tmp/project-b");
      manager.getSnapshot(cwdA);
      manager.getSnapshot(cwdB);

      listener.mockClear();
      manager.applyMutableProviderConfig({
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      });

      const cwds = listener.mock.calls.map((call) => call[1]).sort();
      expect(cwds).toEqual([cwdA, cwdB].sort());
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager lifecycle", () => {
  test("on/off attaches and detaches change listeners", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const listener = vi.fn();
      manager.on("change", listener);
      manager.getSnapshot("/tmp/project");
      manager.applyMutableProviderConfig({});
      const firstCallCount = listener.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      manager.off("change", listener);
      manager.applyMutableProviderConfig({});
      expect(listener.mock.calls.length).toBe(firstCallCount);
    } finally {
      manager.destroy();
    }
  });

  test("destroy clears snapshots and prevents further change emissions", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    const listener = vi.fn();
    manager.on("change", listener);
    manager.getSnapshot("/tmp/project");
    manager.destroy();

    listener.mockClear();
    manager.applyMutableProviderConfig({});
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ProviderSnapshotManager cwd routing", () => {
  test("settings refresh passes the semantic global scope to providers", async () => {
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["codex"] });

      expect(fetchCatalog.mock.calls[0]?.[0]).toMatchObject({ scope: "global", force: true });
    } finally {
      manager.destroy();
    }
  });

  test("global snapshot does not satisfy an explicit home workspace read", async () => {
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["codex"] });
      await manager.listProviders({ cwd: homedir(), providers: ["codex"], wait: true });

      expect(fetchCatalog.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({ scope: "global", force: true }),
        expect.objectContaining({
          scope: "workspace",
          cwd: resolveSnapshotCwd(homedir()),
          force: false,
        }),
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("different cwd keys produce independent snapshots", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const a = manager.getSnapshot("/tmp/project-a");
      const b = manager.getSnapshot("/tmp/project-b");
      expect(a).not.toBe(b);
      expect(a.map((entry) => entry.provider).sort()).toEqual(
        b.map((entry) => entry.provider).sort(),
      );
    } finally {
      manager.destroy();
    }
  });

  test("getSnapshot called with no cwd resolves to the global snapshot key", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const listener = vi.fn();
      manager.on("change", listener);
      manager.getSnapshot();
      manager.applyMutableProviderConfig({});
      const cwds = listener.mock.calls.map((call) => call[1]);
      expect(cwds).toContain(GLOBAL_PROVIDER_SNAPSHOT_KEY);
    } finally {
      manager.destroy();
    }
  });

  test("resolveSnapshotCwd normalizes pure drive letters to append backslash on Windows", () => {
    const resolved = resolveSnapshotCwd("C:");
    if (process.platform === "win32") {
      expect(resolved).toBe("C:\\");
    } else {
      expect(resolved).toBeDefined();
    }
  });
});
