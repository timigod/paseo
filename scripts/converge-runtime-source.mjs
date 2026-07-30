#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remote = "paseo-runtime";
const branch = "fix/paseo-027-control-lane";
const remoteUrl = "https://github.com/timigod/paseo.git";
const macbookRoot = "/Users/timiajiboye/Code/paseo-0.1.110-eof-fix";
const imacRoot = "/Users/timi/Code/paseo-0.1.110-eof-fix";
const installedCli = "/Applications/Paseo.app/Contents/Resources/bin/paseo";

function fail(message) {
  throw new Error(`Paseo runtime source convergence refused: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    fail(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function git(root, args) {
  return run("git", ["-C", root, ...args]);
}

function gitUrls(root, args) {
  return run("git", ["-C", root, ...args])
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function assertSingleCanonicalUrl(root, args) {
  const urls = gitUrls(root, args);
  if (urls.length !== 1 || urls[0] !== remoteUrl) {
    fail(
      `${root} must have one ${remote} ${args.includes("--push") ? "push " : ""}URL equal to ${remoteUrl}`,
    );
  }
}

function ensureCanonicalRemote(root) {
  const existing = spawnSync("git", ["-C", root, "remote", "get-url", "--all", remote], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (existing.error) fail(`could not inspect ${remote} in ${root}: ${existing.error.message}`);
  if (existing.status !== 0) {
    run("git", ["-C", root, "remote", "add", remote, remoteUrl]);
  }
  assertSingleCanonicalUrl(root, ["remote", "get-url", "--all", remote]);
  assertSingleCanonicalUrl(root, ["remote", "get-url", "--push", "--all", remote]);
}

function assertPrimary(root) {
  const localHost = os.hostname().toLowerCase();
  let expectedRoot = null;
  if (localHost.startsWith("timis-macbook-pro")) {
    expectedRoot = macbookRoot;
  } else if (localHost.startsWith("imac")) {
    expectedRoot = imacRoot;
  }
  if (!expectedRoot) fail(`this host is not a declared Paseo runtime host (${os.hostname()})`);
  if (path.resolve(root) !== expectedRoot) {
    fail(
      `run this only from the clean primary source checkout ${expectedRoot}, never from a feature worktree`,
    );
  }
  return expectedRoot === macbookRoot ? "macbook" : "imac";
}

function assertCleanPrimary(root) {
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    fail(`${root} is dirty; source convergence never overwrites local work`);
  }
  if (git(root, ["branch", "--show-current"]) !== branch) {
    fail(`${root} is not on ${branch}`);
  }
}

function canonicalHead(root) {
  git(root, ["fetch", remote, branch]);
  return git(root, ["rev-parse", "FETCH_HEAD"]);
}

function fastForward(root, expected) {
  git(root, ["merge", "--ff-only", expected]);
  const actual = git(root, ["rev-parse", "HEAD"]);
  if (actual !== expected) fail(`${root} did not reach the expected canonical commit`);
}

function buildCliArtifacts(root) {
  run("npm", ["run", "build:client"], { cwd: root });
  run("npm", ["run", "build", "--workspace=@getpaseo/cli"], { cwd: root });
  run("node", ["packages/cli/dist/index.js", "fleet", "--help"], { cwd: root });
  run("node", ["packages/cli/dist/index.js", "fleet", "continue", "--help"], { cwd: root });
  activateInstalledCli();
  assertCleanPrimary(root);
}

function activateInstalledCli() {
  if (!existsSync(installedCli)) {
    fail(`the installed Paseo app CLI is missing at ${installedCli}`);
  }
  const shimDir = path.join(os.homedir(), ".local", "bin");
  const shim = path.join(shimDir, "paseo");
  mkdirSync(shimDir, { recursive: true });
  rmSync(shim, { force: true });
  symlinkSync(installedCli, shim, "file");
  if (realpathSync(shim) !== realpathSync(installedCli)) {
    fail("the bare paseo command does not resolve to the installed app CLI");
  }
  run(installedCli, ["fleet", "--help"]);
  run(installedCli, ["fleet", "continue", "--help"]);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

function peerCommand(root, expected, setupOnly, buildCli) {
  const merge = setupOnly
    ? ""
    : [
        `actual="$(git -C "$repo" rev-parse "$expected")"`,
        'test "$actual" = "$expected"',
        'git -C "$repo" merge --ff-only "$expected"',
        'test "$(git -C "$repo" rev-parse HEAD)" = "$expected"',
      ].join("\n");
  const build = buildCli
    ? [
        'cd "$repo"',
        "npm run build:client",
        "npm run build --workspace=@getpaseo/cli",
        "node packages/cli/dist/index.js fleet --help >/dev/null",
        "node packages/cli/dist/index.js fleet continue --help >/dev/null",
        `installed_cli=${shellQuote(installedCli)}`,
        'test -x "$installed_cli"',
        'mkdir -p "$HOME/.local/bin"',
        'ln -sfn "$installed_cli" "$HOME/.local/bin/paseo"',
        'test "$(readlink "$HOME/.local/bin/paseo")" = "$installed_cli"',
        '"$installed_cli" fleet --help >/dev/null',
        '"$installed_cli" fleet continue --help >/dev/null',
        'test -z "$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"',
      ].join("\n")
    : "";
  return [
    "set -eu",
    "export COREPACK_ENABLE_AUTO_PIN=0",
    `repo=${shellQuote(root)}`,
    `remote=${shellQuote(remote)}`,
    `branch=${shellQuote(branch)}`,
    `remote_url=${shellQuote(remoteUrl)}`,
    `expected=${shellQuote(expected || "")}`,
    'test -d "$repo/.git"',
    'test -z "$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"',
    `test "$(git -C "$repo" branch --show-current)" = ${shellQuote(branch)}`,
    'if ! git -C "$repo" remote get-url --all "$remote" >/dev/null 2>&1; then git -C "$repo" remote add "$remote" "$remote_url"; fi',
    'test "$(git -C "$repo" remote get-url --all "$remote")" = "$remote_url"',
    'test "$(git -C "$repo" remote get-url --push --all "$remote")" = "$remote_url"',
    'git -C "$repo" fetch "$remote" "$branch"',
    merge,
    build,
    'printf "paseo_runtime_commit=%s\\n" "$(git -C "$repo" rev-parse FETCH_HEAD)"',
  ]
    .filter(Boolean)
    .join("\n");
}

function peerSsh(kind, command) {
  let output;
  if (kind === "macbook") {
    output = run("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "imac",
      "zsh",
      "-lc",
      command,
    ]);
  } else {
    output = run("ssh", [
      "-i",
      "/Users/timi/.ssh/broker-imac-macbook",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=10",
      "timiajiboye@timis-macbook-pro.tail24bbb3.ts.net",
      "zsh",
      "-lc",
      command,
    ]);
  }
  const match = output.match(/(?:^|\n)paseo_runtime_commit=([0-9a-f]{40})\s*$/u);
  if (!match) fail("the peer did not attest its fetched canonical commit");
  return match[1];
}

function parseArguments(args) {
  const values = new Set(args);
  for (const value of values) {
    if (!["--setup-only", "--dry-run"].includes(value)) fail(`unknown argument ${value}`);
  }
  if (values.has("--setup-only") && values.has("--dry-run"))
    fail("--setup-only and --dry-run cannot be combined");
  return { setupOnly: values.has("--setup-only"), dryRun: values.has("--dry-run") };
}

function main() {
  const { setupOnly, dryRun } = parseArguments(process.argv.slice(2));
  const kind = assertPrimary(scriptRoot);
  assertCleanPrimary(scriptRoot);
  ensureCanonicalRemote(scriptRoot);
  const peerRoot = kind === "macbook" ? imacRoot : macbookRoot;

  if (setupOnly) {
    peerSsh(kind, peerCommand(peerRoot, null, true, false));
    console.log(
      JSON.stringify({ status: "configured", remote, branch, local: scriptRoot, peer: peerRoot }),
    );
    return;
  }

  const expected = dryRun
    ? run("git", ["ls-remote", "--exit-code", remoteUrl, `refs/heads/${branch}`]).split(/\s+/u)[0]
    : canonicalHead(scriptRoot);
  if (!/^[0-9a-f]{40}$/u.test(expected)) fail("the canonical remote returned an invalid commit id");
  if (!dryRun) fastForward(scriptRoot, expected);
  if (!dryRun) buildCliArtifacts(scriptRoot);
  const peerHead = peerSsh(kind, peerCommand(peerRoot, expected, dryRun, !dryRun));
  if (peerHead !== expected)
    fail("the peer fetched a different canonical commit; no source tree was overwritten");
  console.log(
    JSON.stringify({
      status: dryRun ? "verified" : "converged",
      remote,
      branch,
      commit: expected,
      local: scriptRoot,
      peer: peerRoot,
      ...(dryRun ? {} : { cliArtifacts: "built" }),
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
