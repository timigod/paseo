import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  drainGitCommands,
  runGitCommand,
  snapshotGitCommandRuntimeMetrics,
  startGitCommandMetrics,
  stopGitCommandMetrics,
} from "./run-git-command.js";

describe("runGitCommand synchronous spawn validation", () => {
  beforeEach(() => {
    snapshotGitCommandRuntimeMetrics();
    startGitCommandMetrics();
  });

  afterEach(async () => {
    await drainGitCommands();
    stopGitCommandMetrics();
    snapshotGitCommandRuntimeMetrics();
  });

  it.each([
    ["cwd", ["status"], `${process.cwd()}\0invalid`],
    ["argument", ["status", "bad\0argument"], process.cwd()],
  ])("settles metrics for an invalid NUL %s", async (_label, args, cwd) => {
    await expect(runGitCommand(args, { cwd })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_VALUE",
    });
    await drainGitCommands();

    expect(stopGitCommandMetrics()).toMatchObject({
      total: 1,
      failed: 1,
      maxConcurrent: 1,
      commands: [
        expect.objectContaining({
          args,
          cwd,
          exitCode: null,
          signal: null,
          success: false,
        }),
      ],
    });
    expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
      submitted: 1,
      admitted: 1,
      canceled: 0,
      started: 1,
      completed: 1,
      failed: 1,
      active: 0,
      pending: 0,
      queueWaitMs: { count: 1 },
      executionMs: { count: 1 },
    });
  });
});
