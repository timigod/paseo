import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";
import type { OpenCodeServerAcquisition } from "./opencode/server-manager.js";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

test("allows a slow provider.list call to succeed instead of failing after 10 seconds", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListImplementation = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          data: {
            connected: ["zai"],
            all: [
              {
                id: "zai",
                name: "Z.AI",
                models: {
                  "glm-5.1": {
                    name: "GLM 5.1",
                    limit: { context: 128_000 },
                  },
                },
              },
            ],
          },
        });
      }, 15_000);
    });
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const modelsPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(modelsPromise).resolves.toMatchObject({
    models: [
      {
        provider: "opencode",
        id: "zai/glm-5.1",
        label: "GLM 5.1",
      },
    ],
  });
  expect(openCodeClient.calls.providerList).toHaveLength(1);
});

test("uses the supplied catalog budget for mode discovery and releases the runtime on timeout", async () => {
  vi.useFakeTimers();

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
  let modeDiscoverySignal: AbortSignal | undefined;
  openCodeClient.appAgentsImplementation = async (_parameters, options) => {
    modeDiscoverySignal = (options as { signal?: AbortSignal }).signal;
    return await new Promise((resolve, reject) => {
      modeDiscoverySignal?.addEventListener(
        "abort",
        () => reject(new Error("OpenCode app.agents aborted")),
        { once: true },
      );
    });
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const catalogPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
    timeoutMs: 250,
  });

  await vi.advanceTimersByTimeAsync(250);

  await expect(catalogPromise).resolves.toMatchObject({
    models: [{ id: "openai/gpt-5.4" }],
    modes: [],
    modeDiscoveryError: "OpenCode app.agents timed out within the 250ms catalog budget",
  });
  expect(modeDiscoverySignal?.aborted).toBe(true);
  expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
});

test("times out a pending server acquisition and releases a late handle exactly once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);

  const runtime = new TestOpenCodeHarness();
  const acquireCurrent = runtime.acquireCurrent.bind(runtime);
  const deferredAcquisition = createDeferred<OpenCodeServerAcquisition>();
  vi.spyOn(runtime, "acquireCurrent").mockReturnValue(deferredAcquisition.promise);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const catalogPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
    timeoutMs: 250,
  });
  const rejection = expect(catalogPromise).rejects.toThrow(
    "OpenCode server acquisition timed out within the 250ms catalog budget",
  );

  await vi.advanceTimersByTimeAsync(250);
  await rejection;
  expect(runtime.clientCreations).toEqual([]);
  expect(runtime.acquisitions).toEqual([]);

  deferredAcquisition.resolve(await acquireCurrent());
  await vi.waitFor(() => {
    expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
  });
  await vi.runAllTimersAsync();
  expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
  expect(runtime.clientCreations).toEqual([]);
});

test("aborts a pending server acquisition and releases a late handle exactly once", async () => {
  const runtime = new TestOpenCodeHarness();
  const acquireCurrent = runtime.acquireCurrent.bind(runtime);
  const deferredAcquisition = createDeferred<OpenCodeServerAcquisition>();
  vi.spyOn(runtime, "acquireCurrent").mockReturnValue(deferredAcquisition.promise);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const controller = new AbortController();
  const catalogPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  const rejection = expect(catalogPromise).rejects.toThrow(
    "OpenCode server acquisition aborted by caller",
  );

  controller.abort();
  await rejection;
  expect(runtime.clientCreations).toEqual([]);
  expect(runtime.acquisitions).toEqual([]);

  deferredAcquisition.resolve(await acquireCurrent());
  await vi.waitFor(() => {
    expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
  });
  await Promise.resolve();
  expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
  expect(runtime.clientCreations).toEqual([]);
});

test("keeps models usable and reports degraded mode discovery when app.agents errors", async () => {
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
  openCodeClient.appAgentsResponse = { error: { message: "agent config is still loading" } };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/opencode-models",
      force: false,
      timeoutMs: 500,
    }),
  ).resolves.toMatchObject({
    models: [{ id: "openai/gpt-5.4" }],
    modes: [],
    modeDiscoveryError: expect.stringContaining("agent config is still loading"),
  });
  expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
});

test("uses a new server for explicit catalog refresh", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: true });

  expect(runtime.acquisitions).toEqual([{ kind: "new", releaseCount: 1 }]);
});

test("includes models from api-source providers not in connected", async () => {
  // Providers with source "api" are managed by the OpenCode console/subscription.
  // They don't appear in `connected` but are fully usable.
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "api",
          models: {
            "pi-model-1": {
              name: "Pi Model 1",
              limit: { context: 200_000 },
            },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const { models } = await client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });

  expect(models).toMatchObject([
    {
      provider: "opencode",
      id: "pi/pi-model-1",
      label: "Pi Model 1",
    },
  ]);
});

test("throws when no providers are accessible (neither connected nor api-source)", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "env",
          models: {
            "claude-opus": { name: "Claude Opus", limit: { context: 1_000_000 } },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: false }),
  ).rejects.toThrow("OpenCode has no connected providers");
});

test("does not throw when only api-source providers are present with no connected providers", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "api",
          models: {
            "pi-model-1": { name: "Pi Model 1", limit: { context: 200_000 } },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: false }),
  ).resolves.toMatchObject({
    models: [
      {
        provider: "opencode",
        id: "pi/pi-model-1",
        label: "Pi Model 1",
      },
    ],
  });
});
