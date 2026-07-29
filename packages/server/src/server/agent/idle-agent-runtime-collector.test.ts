import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { IdleAgentRuntimeCollector } from "./idle-agent-runtime-collector.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

test("computes the idle cutoff and passes active scheduled targets to the manager", async () => {
  const collectIdleAgents = vi.fn(async () => ({ collected: [], failures: [] }));
  const listActiveAgentTargetIds = vi.fn(async () => new Set(["scheduled-agent"]));
  const now = new Date("2026-07-29T12:00:00.000Z");
  const collector = new IdleAgentRuntimeCollector({
    agentManager: { collectIdleAgents },
    activeAgentTargets: { listActiveAgentTargetIds },
    logger: createTestLogger(),
    now: () => now,
    idleTtlMs: 120_000,
  });

  await collector.runOnce();

  expect(collectIdleAgents).toHaveBeenCalledWith({
    cutoff: new Date("2026-07-29T11:58:00.000Z"),
    protectedAgentIds: new Set(["scheduled-agent"]),
  });
  await collector.stop();
});

test("serializes timer sweeps and shutdown waits for in-flight cleanup", async () => {
  vi.useFakeTimers();
  const collectionStarted = deferred<void>();
  const collectionAllowed = deferred<void>();
  const collectIdleAgents = vi.fn(async () => {
    collectionStarted.resolve();
    await collectionAllowed.promise;
    return { collected: [], failures: [] };
  });
  const collector = new IdleAgentRuntimeCollector({
    agentManager: { collectIdleAgents },
    activeAgentTargets: { listActiveAgentTargetIds: async () => new Set() },
    logger: createTestLogger(),
    sweepIntervalMs: 100,
  });
  collector.start();

  await vi.advanceTimersByTimeAsync(100);
  await collectionStarted.promise;
  await vi.advanceTimersByTimeAsync(500);
  expect(collectIdleAgents).toHaveBeenCalledTimes(1);

  let stopped = false;
  const stop = collector.stop().then(() => {
    stopped = true;
    return undefined;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);

  collectionAllowed.resolve();
  await stop;
  expect(stopped).toBe(true);

  await vi.advanceTimersByTimeAsync(500);
  expect(collectIdleAgents).toHaveBeenCalledTimes(1);
});
