import { expect, test } from "vitest";

import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
} from "../agent-runtime-capacity.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { TestOpenCodeHarness } from "./opencode/test-utils/test-opencode-harness.js";

test("OpenCode owns runtime admission and forwards the host controller", () => {
  const serverManager = new TestOpenCodeHarness();
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { serverManager });
  const controller = new HostAgentRuntimeCapacityController(1);

  client.configureRuntimeCapacityController(controller);

  expect(client.managesRuntimeCapacityAtSource).toBe(true);
  expect(serverManager.runtimeCapacityController).toBe(controller);
});

test("OpenCode availability does not start executable discovery when capacity is full", async () => {
  const serverManager = new TestOpenCodeHarness();
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { serverManager });
  const controller = new HostAgentRuntimeCapacityController(1);
  const existingRuntime = {};
  controller.reserve().track(existingRuntime);
  client.configureRuntimeCapacityController(controller);

  await expect(client.isAvailable()).rejects.toBeInstanceOf(AgentRuntimeCapacityError);

  controller.release(existingRuntime);
});

test("OpenCode diagnostics do not start executable discovery when capacity is full", async () => {
  const serverManager = new TestOpenCodeHarness();
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, { serverManager });
  const controller = new HostAgentRuntimeCapacityController(1);
  const existingRuntime = {};
  controller.reserve().track(existingRuntime);
  client.configureRuntimeCapacityController(controller);

  const { diagnostic } = await client.getDiagnostic();

  expect(diagnostic).toContain("Host agent runtime capacity reached");
  controller.release(existingRuntime);
});
