import { describe, expect, test } from "vitest";
import { WorkerLiveness } from "./worker-liveness.js";

class FakeClock {
  nowMs = 0;

  now = () => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

describe("WorkerLiveness", () => {
  test("keeps a worker in recovery through a slow declared recovery", () => {
    const clock = new FakeClock();
    const liveness = new WorkerLiveness({
      clock,
      heartbeatTimeoutMs: 15_000,
      recoveryTimeoutMs: 60_000,
    });

    clock.advance(33_000);
    expect(liveness.getPhase()).toBe("recovering");
    expect(liveness.getExpiredReason()).toBeNull();
  });

  test("arms the normal heartbeat deadline only after readiness", () => {
    const clock = new FakeClock();
    const liveness = new WorkerLiveness({
      clock,
      heartbeatTimeoutMs: 15_000,
      recoveryTimeoutMs: 60_000,
    });

    clock.advance(33_000);
    liveness.markReady();
    clock.advance(14_999);
    expect(liveness.getExpiredReason()).toBeNull();
    clock.advance(1);
    expect(liveness.getExpiredReason()).toEqual({
      reason: "worker_heartbeat_timeout",
      ageMs: 15_000,
    });
  });

  test("does not time out a ready worker that continues to heartbeat", () => {
    const clock = new FakeClock();
    const liveness = new WorkerLiveness({
      clock,
      heartbeatTimeoutMs: 15_000,
      recoveryTimeoutMs: 60_000,
    });

    liveness.markReady();
    for (let index = 0; index < 4; index += 1) {
      clock.advance(14_999);
      liveness.recordHeartbeat();
      expect(liveness.getExpiredReason()).toBeNull();
    }
  });

  test("uses a distinct deadline when recovery never completes", () => {
    const clock = new FakeClock();
    const liveness = new WorkerLiveness({
      clock,
      heartbeatTimeoutMs: 15_000,
      recoveryTimeoutMs: 60_000,
    });

    clock.advance(60_000);
    expect(liveness.getExpiredReason()).toEqual({
      reason: "worker_recovery_timeout",
      ageMs: 60_000,
    });
  });
});
