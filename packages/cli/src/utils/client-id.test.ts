import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.resetModules();
  delete process.env.PASEO_HOME;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it("concurrent first use converges on one owner-only CLI identity", async () => {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-cli-client-id-"));
  directories.push(paseoHome);
  process.env.PASEO_HOME = paseoHome;
  const { getOrCreateCliClientId } = await import("./client-id.js");

  const identities = await Promise.all(Array.from({ length: 20 }, () => getOrCreateCliClientId()));
  const filePath = path.join(paseoHome, "cli-client-id");

  expect(new Set(identities).size).toBe(1);
  expect(await readFile(filePath, "utf8")).toBe(identities[0]);
  expect((await stat(filePath)).mode & 0o777).toBe(0o600);
});

it("simultaneous CLI processes converge on one private identity", async () => {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-cli-client-id-processes-"));
  directories.push(paseoHome);
  const moduleUrl = new URL("./client-id.ts", import.meta.url).href;
  const script = `import { getOrCreateCliClientId } from ${JSON.stringify(moduleUrl)}; process.stdout.write(await getOrCreateCliClientId());`;

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        { env: { ...process.env, PASEO_HOME: paseoHome } },
      ),
    ),
  );
  const identities = results.map(({ stdout }) => stdout);
  const filePath = path.join(paseoHome, "cli-client-id");

  expect(new Set(identities).size).toBe(1);
  expect(await readFile(filePath, "utf8")).toBe(identities[0]);
  expect((await stat(paseoHome)).mode & 0o777).toBe(0o700);
  expect((await stat(filePath)).mode & 0o777).toBe(0o600);
});
