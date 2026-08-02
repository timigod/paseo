import { describe, expect, test } from "vitest";

import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
} from "./agent-runtime-capacity.js";

describe("HostAgentRuntimeCapacityController", () => {
  test("projects unbounded runtime capacity without inventing finite headroom", () => {
    const controller = new HostAgentRuntimeCapacityController(null);

    expect(controller.snapshot()).toEqual({
      limit: null,
      live: 0,
      reserved: 0,
      free: null,
    });
  });

  test("projects replacement headroom from live runtimes and in-flight reservations", () => {
    const controller = new HostAgentRuntimeCapacityController(12);
    const runtimes = Array.from({ length: 10 }, () => ({}));
    for (const runtime of runtimes) controller.reserve().track(runtime);

    expect(controller.snapshot()).toEqual({ limit: 12, live: 10, reserved: 0, free: 2 });

    const replacement = controller.reserve();
    expect(controller.snapshot()).toEqual({ limit: 12, live: 10, reserved: 1, free: 1 });

    replacement.release();
    expect(controller.snapshot()).toEqual({ limit: 12, live: 10, reserved: 0, free: 2 });
  });

  test("atomically rejects a concurrent reservation at the host limit", () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const first = controller.reserve();

    expect(() => controller.reserve()).toThrow(
      expect.objectContaining<Partial<AgentRuntimeCapacityError>>({
        name: "AgentRuntimeCapacityError",
        live: 0,
        reserved: 1,
      }),
    );

    first.release();
    expect(() => controller.reserve()).not.toThrow();
  });

  test("keeps a started runtime charged until that exact runtime is released", () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const runtime = {};
    controller.reserve().track(runtime);

    expect(() => controller.reserve()).toThrow(
      expect.objectContaining<Partial<AgentRuntimeCapacityError>>({ live: 1, reserved: 0 }),
    );
    controller.release({});
    expect(() => controller.reserve()).toThrow(AgentRuntimeCapacityError);

    controller.release(runtime);
    expect(() => controller.reserve()).not.toThrow();
  });
});
