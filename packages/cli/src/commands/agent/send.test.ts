import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePromptInput } from "./send.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("resolvePromptInput", () => {
  it("reads a valid UTF-8 prompt file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-send-prompt-"));
    cleanup.push(directory);
    const promptFile = path.join(directory, "prompt.txt");
    await writeFile(promptFile, "private prompt contents\n", "utf8");

    await expect(
      resolvePromptInput({
        promptArgument: undefined,
        promptOption: undefined,
        promptFile,
      }),
    ).resolves.toBe("private prompt contents\n");
  });

  it("rejects empty and invalid UTF-8 prompt files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-send-prompt-"));
    cleanup.push(directory);
    const emptyFile = path.join(directory, "empty.txt");
    const invalidFile = path.join(directory, "invalid.txt");
    await writeFile(emptyFile, "  \n", "utf8");
    await writeFile(invalidFile, Buffer.from([0xc3, 0x28]));

    await expect(
      resolvePromptInput({
        promptArgument: undefined,
        promptOption: undefined,
        promptFile: emptyFile,
      }),
    ).rejects.toMatchObject({ code: "EMPTY_PROMPT_FILE" });
    await expect(
      resolvePromptInput({
        promptArgument: undefined,
        promptOption: undefined,
        promptFile: invalidFile,
      }),
    ).rejects.toMatchObject({ code: "PROMPT_FILE_DECODE_ERROR" });
  });

  it("reports a missing prompt file as a read error", async () => {
    await expect(
      resolvePromptInput({
        promptArgument: undefined,
        promptOption: undefined,
        promptFile: "/missing/paseo-prompt.txt",
      }),
    ).rejects.toMatchObject({ code: "PROMPT_FILE_READ_ERROR" });
  });
});
