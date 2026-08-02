import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { isPlatform } from "../test-utils/platform.js";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    promises: {
      ...original.promises,
      ...fsMocks,
    },
  };
});

import { removeFileDurable, writeFileAtomic } from "./atomic-file.js";

describe("atomic file durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.skipIf(isPlatform("win32"))(
    "syncs owner-only contents before rename and the directory after rename",
    async () => {
      const events: string[] = [];
      const directory = path.resolve("fixture-state");
      const filePath = path.join(directory, "owner.json");
      const tempHandle = {
        writeFile: vi.fn(async () => {
          events.push("write");
        }),
        sync: vi.fn(async () => {
          events.push("sync-file");
        }),
        close: vi.fn(async () => {
          events.push("close-file");
        }),
      };
      const directoryHandle = {
        sync: vi.fn(async () => {
          events.push("sync-directory");
        }),
        close: vi.fn(async () => {
          events.push("close-directory");
        }),
      };
      fsMocks.mkdir.mockImplementation(async () => {
        events.push("mkdir");
      });
      fsMocks.open.mockImplementation(async (target: string, flags: string, mode?: number) => {
        if (target === directory) {
          events.push(`open-directory:${flags}`);
          return directoryHandle;
        }
        events.push(`open-temp:${flags}:${mode?.toString(8)}`);
        return tempHandle;
      });
      fsMocks.rename.mockImplementation(async () => {
        events.push("rename");
      });

      await writeFileAtomic(filePath, "secret", { mode: 0o600, durable: true });

      expect(events).toEqual([
        "mkdir",
        "open-temp:wx:600",
        "write",
        "sync-file",
        "close-file",
        "rename",
        "open-directory:r",
        "sync-directory",
        "close-directory",
      ]);
    },
  );

  test.skipIf(isPlatform("win32"))(
    "syncs the containing directory after removing durable state",
    async () => {
      const events: string[] = [];
      const directory = path.resolve("fixture-state");
      const filePath = path.join(directory, "owner.json");
      const directoryHandle = {
        sync: vi.fn(async () => {
          events.push("sync-directory");
        }),
        close: vi.fn(async () => {
          events.push("close-directory");
        }),
      };
      fsMocks.unlink.mockImplementation(async () => {
        events.push("unlink");
      });
      fsMocks.open.mockImplementation(async () => {
        events.push("open-directory");
        return directoryHandle;
      });

      await removeFileDurable(filePath);

      expect(events).toEqual(["unlink", "open-directory", "sync-directory", "close-directory"]);
    },
  );
});
