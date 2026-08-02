import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveFleetProviderModelOptions,
  resolveFleetRunPrompt,
  resolveFleetWorktreeBase,
} from "./run.js";

const cleanup: string[] = [];
const head = "0123456789abcdef0123456789abcdef01234567";
const defaults = {
  provider: "provider-a",
  model: "model-a",
  thinking: "balanced",
};

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("fleet run inputs", () => {
  it("uses externally configured defaults only when no provider or model was explicit", () => {
    expect(resolveFleetProviderModelOptions({}, defaults)).toEqual({
      provider: "provider-a",
      model: "model-a",
      effectiveProvider: "provider-a",
      effectiveModel: "model-a",
    });
  });

  it("lets an explicit embedded provider model replace the implicit default", () => {
    expect(resolveFleetProviderModelOptions({ provider: "provider-b/model-b" }, defaults)).toEqual({
      provider: "provider-b/model-b",
      model: undefined,
      effectiveProvider: "provider-b",
      effectiveModel: "model-b",
    });
  });

  it("uses the fleet provider with an explicit model", () => {
    expect(resolveFleetProviderModelOptions({ model: "custom-model" }, defaults)).toMatchObject({
      provider: "provider-a",
      model: "custom-model",
      effectiveProvider: "provider-a",
      effectiveModel: "custom-model",
    });
  });

  it("keeps rejecting contradictory explicit model values", () => {
    expect(() =>
      resolveFleetProviderModelOptions(
        { provider: "provider-b/model-b", model: "model-c" },
        defaults,
      ),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_MODEL_OPTIONS" }));
  });

  it("reads exactly one UTF-8 prompt file without logging its contents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-prompt-"));
    cleanup.push(directory);
    const promptFile = path.join(directory, "prompt.txt");
    await writeFile(promptFile, "private prompt contents\n", "utf8");

    await expect(resolveFleetRunPrompt(undefined, { promptFile })).resolves.toBe(
      "private prompt contents\n",
    );
  });

  it("rejects missing, conflicting, empty, and invalid UTF-8 prompt input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-prompt-"));
    cleanup.push(directory);
    const emptyFile = path.join(directory, "empty.txt");
    const invalidFile = path.join(directory, "invalid.txt");
    await writeFile(emptyFile, "  \n", "utf8");
    await writeFile(invalidFile, Buffer.from([0xc3, 0x28]));

    await expect(resolveFleetRunPrompt(undefined, {})).rejects.toMatchObject({
      code: "MISSING_PROMPT",
    });
    await expect(resolveFleetRunPrompt("argument", { prompt: "option" })).rejects.toMatchObject({
      code: "CONFLICTING_PROMPT_INPUT",
    });
    await expect(resolveFleetRunPrompt(undefined, { promptFile: emptyFile })).rejects.toMatchObject(
      { code: "EMPTY_PROMPT_FILE" },
    );
    await expect(
      resolveFleetRunPrompt(undefined, { promptFile: invalidFile }),
    ).rejects.toMatchObject({ code: "PROMPT_FILE_DECODE_ERROR" });
  });
});

describe("fleet worktree base", () => {
  it("uses the caller's exact commit for a branch-off fleet worktree", () => {
    expect(resolveFleetWorktreeBase({ newWorkspace: "worktree" }, "/repo", () => head)).toBe(head);
  });

  it("fails closed when the caller cwd does not resolve to a full Git commit", () => {
    const readBadHead = () => "bad";
    expect(() =>
      resolveFleetWorktreeBase({ newWorkspace: "worktree" }, "/not-a-repo", readBadHead),
    ).toThrow(expect.objectContaining({ code: "FLEET_WORKTREE_BASE_UNRESOLVED" }));
  });

  it("lets the target daemon resolve the base for a remote-only cwd", () => {
    const readHead = vi.fn(() => {
      throw new Error("remote path does not exist on caller");
    });

    expect(
      resolveFleetWorktreeBase(
        { newWorkspace: "worktree" },
        "/Users/remote/Code/paseo",
        readHead,
        false,
      ),
    ).toBeUndefined();
    expect(readHead).not.toHaveBeenCalled();
  });
});
