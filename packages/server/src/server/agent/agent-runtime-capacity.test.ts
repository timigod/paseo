import { describe, expect, test } from "vitest";

import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
  withTemporaryRuntimeCapacity,
} from "./agent-runtime-capacity.js";

describe("HostAgentRuntimeCapacityController", () => {
  test("atomically rejects a concurrent reservation at the host limit", () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const first = controller.reserve();

    expect(controller.getAvailableRuntimeSlots()).toBe(0);
    expect(() => controller.reserve()).toThrow(
      expect.objectContaining<Partial<AgentRuntimeCapacityError>>({
        name: "AgentRuntimeCapacityError",
        live: 0,
        reserved: 1,
      }),
    );

    first.release();
    expect(controller.getAvailableRuntimeSlots()).toBe(1);
    expect(controller.getSnapshot()).toEqual({
      limit: 1,
      live: 0,
      starting: 0,
      available: 1,
    });
    expect(() => controller.reserve()).not.toThrow();
  });

  test("reports live and starting runtimes from the authoritative admission controller", () => {
    const controller = new HostAgentRuntimeCapacityController(3);
    const runtime = {};
    controller.reserve().track(runtime);
    const starting = controller.reserve();

    expect(controller.getSnapshot()).toEqual({
      limit: 3,
      live: 1,
      starting: 1,
      available: 1,
    });

    starting.release();
    controller.release(runtime);
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

  test("rejects an invalid configured limit", () => {
    expect(() => new HostAgentRuntimeCapacityController(0)).toThrow(
      new RangeError("maxActiveAgentRuntimes must be a positive integer"),
    );
  });

  test("holds a temporary reservation until an operation settles", async () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    let finishOperation = () => {};
    const operationFinished = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });

    const operation = withTemporaryRuntimeCapacity(controller, async () => {
      expect(controller.getAvailableRuntimeSlots()).toBe(0);
      await operationFinished;
      return "complete";
    });

    expect(() => controller.reserve()).toThrow(AgentRuntimeCapacityError);
    finishOperation();
    await expect(operation).resolves.toBe("complete");
    expect(controller.getAvailableRuntimeSlots()).toBe(1);
  });
});
