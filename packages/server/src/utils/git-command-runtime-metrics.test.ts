import { describe, expect, test } from "vitest";
import { GitCommandRuntimeMetricsWindow } from "./git-command-runtime-metrics.js";

function createMetricsWindow(concurrencyLimit = 2) {
  let now = 1_000;
  return {
    metrics: new GitCommandRuntimeMetricsWindow(concurrencyLimit, () => now),
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("GitCommandRuntimeMetricsWindow", () => {
  test("separates queue wait from execution time", () => {
    const { metrics, advance } = createMetricsWindow();
    const command = metrics.submit("status");
    advance(40);
    metrics.start(command);
    advance(15);
    metrics.finish(command, { success: true, timedOut: false });

    expect(metrics.snapshotAndReset()).toMatchObject({
      submitted: 1,
      admitted: 1,
      rejected: 0,
      canceled: 0,
      started: 1,
      completed: 1,
      failed: 0,
      timedOut: 0,
      queueWaitMs: { count: 1, p50Ms: 40, p95Ms: 40, maxMs: 40 },
      executionMs: { count: 1, p50Ms: 15, p95Ms: 15, maxMs: 15 },
      operationsTop: [["status", 1]],
    });
  });

  test("reports live queue pressure across window resets", () => {
    const { metrics, advance } = createMetricsWindow(1);
    const active = metrics.submit("fetch");
    metrics.start(active);
    const pending = metrics.submit("rev-parse");
    metrics.observeLimiter(1, 1);
    advance(25);

    expect(metrics.snapshotAndReset()).toMatchObject({
      concurrencyLimit: 1,
      active: 1,
      pending: 1,
      peakActive: 1,
      peakPending: 1,
      oldestPendingMs: 25,
      submitted: 2,
      admitted: 2,
      rejected: 0,
      started: 1,
    });

    advance(10);
    metrics.finish(active, { success: true, timedOut: false });
    metrics.start(pending);
    metrics.observeLimiter(1, 0);
    advance(5);
    metrics.finish(pending, { success: false, timedOut: true });

    expect(metrics.snapshotAndReset()).toMatchObject({
      active: 0,
      pending: 0,
      peakActive: 1,
      peakPending: 1,
      submitted: 0,
      admitted: 0,
      rejected: 0,
      started: 1,
      completed: 2,
      failed: 1,
      timedOut: 1,
      queueWaitMs: { count: 1, p50Ms: 35, p95Ms: 35, maxMs: 35 },
    });
  });

  test("separates rejected admission attempts from admitted commands", () => {
    const { metrics } = createMetricsWindow(1);
    const admitted = metrics.submit("status");
    metrics.reject("rev-parse");
    metrics.start(admitted);
    metrics.finish(admitted, { success: true, timedOut: false });

    expect(metrics.snapshotAndReset()).toMatchObject({
      submitted: 2,
      admitted: 1,
      rejected: 1,
      started: 1,
      completed: 1,
      operationsTop: [
        ["rev-parse", 1],
        ["status", 1],
      ],
    });
  });

  test("settles queued cancellation once without recording execution", () => {
    const { metrics } = createMetricsWindow(1);
    const canceled = metrics.submit("status");

    metrics.cancel(canceled);
    metrics.cancel(canceled);

    expect(metrics.snapshotAndReset()).toMatchObject({
      submitted: 1,
      admitted: 1,
      rejected: 0,
      canceled: 1,
      started: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      queueWaitMs: { count: 0 },
      executionMs: { count: 0 },
    });
  });
});
