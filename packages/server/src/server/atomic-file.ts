import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

interface AtomicFileOptions {
  mode?: number;
  durable?: boolean;
  beforeCommit?: () => void | Promise<void>;
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicFileOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  await options.beforeCommit?.();
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let tempHandle;
  try {
    tempHandle = await fs.open(tempPath, "wx", options.mode);
    const contents =
      typeof data === "string"
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    await tempHandle.writeFile(contents, "utf8");
    if (options.durable) {
      await tempHandle.sync();
    }
    await tempHandle.close();
    tempHandle = undefined;
    await options.beforeCommit?.();
    await fs.rename(tempPath, filePath);
    if (options.durable) {
      await syncDirectory(directory);
    }
  } catch (error) {
    await tempHandle?.close();
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options?: AtomicFileOptions,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), options);
}

export async function removeFileDurable(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not permit opening directory handles through node:fs. The file itself is still
  // flushed before rename; POSIX additionally flushes the directory entry for crash durability.
  if (process.platform === "win32") {
    return;
  }
  const directoryHandle = await fs.open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
