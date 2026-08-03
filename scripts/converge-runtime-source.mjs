#!/usr/bin/env node

// Two-host Paseo runtime *source* convergence. This operator converges the
// canonical primary checkouts on both Macs onto one explicit fork runtime
// branch through clean fast-forward only. It never builds, deploys, or
// activates the app, and it never reads or copies ~/.paseo state — app
// deployment and session state are separate lanes with their own owners.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG = Object.freeze({
  remote: "paseo-runtime",
  branch: "runtime/stable",
  remoteUrl: "https://github.com/timigod/paseo.git",
  primaries: Object.freeze({
    macbook: Object.freeze({
      root: "/Users/timiajiboye/Code/paseo",
      hostPrefix: "timis-macbook-pro",
    }),
    imac: Object.freeze({
      root: "/Users/timi/Code/paseo",
      hostPrefix: "imac",
    }),
  }),
});

export function fail(message) {
  throw new Error(`Paseo runtime source convergence refused: ${message}`);
}

export function parseArguments(args) {
  const values = new Set(args);
  for (const value of values) {
    if (!["--setup-only", "--dry-run"].includes(value)) fail(`unknown argument ${value}`);
  }
  if (values.has("--setup-only") && values.has("--dry-run")) {
    fail("--setup-only and --dry-run cannot be combined");
  }
  return { setupOnly: values.has("--setup-only"), dryRun: values.has("--dry-run") };
}

export function resolvePrimary({ hostname, root, config = CONFIG }) {
  const localHost = String(hostname).toLowerCase();
  let kind = null;
  for (const [name, primary] of Object.entries(config.primaries)) {
    if (localHost.startsWith(primary.hostPrefix)) kind = name;
  }
  if (!kind) fail(`this host is not a declared Paseo runtime host (${hostname})`);
  const expectedRoot = config.primaries[kind].root;
  if (path.resolve(root) !== expectedRoot) {
    fail(
      `run this only from the clean canonical primary checkout ${expectedRoot}, never from a feature worktree`,
    );
  }
  const peerKind = kind === "macbook" ? "imac" : "macbook";
  return { kind, root: expectedRoot, peerKind, peerRoot: config.primaries[peerKind].root };
}

export function assertRootOutsidePaseoState(root, paseoHome) {
  const resolvedRoot = path.resolve(root);
  const resolvedState = path.resolve(paseoHome);
  if (resolvedRoot === resolvedState || resolvedRoot.startsWith(`${resolvedState}${path.sep}`)) {
    fail(
      `${root} is inside the Paseo state directory ${paseoHome}; source convergence never touches ~/.paseo state`,
    );
  }
}

export function assertCleanPrimary(git, root, config = CONFIG) {
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    fail(`${root} is dirty; source convergence never overwrites local work`);
  }
  const current = git(root, ["branch", "--show-current"]);
  if (current !== config.branch) {
    fail(`${root} is on '${current}', not the runtime branch '${config.branch}'`);
  }
}

export function assertCanonicalRemote(git, tryGit, root, config = CONFIG) {
  const existing = tryGit(root, ["remote", "get-url", "--all", config.remote]);
  if (existing === null) {
    git(root, ["remote", "add", config.remote, config.remoteUrl]);
  }
  for (const args of [
    ["remote", "get-url", "--all", config.remote],
    ["remote", "get-url", "--push", "--all", config.remote],
  ]) {
    const urls = git(root, args)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (urls.length !== 1 || urls[0] !== config.remoteUrl) {
      fail(
        `${root} must have exactly one ${config.remote} ${args.includes("--push") ? "push " : ""}URL equal to ${config.remoteUrl}`,
      );
    }
  }
}

export function assertCommitId(value) {
  if (!/^[0-9a-f]{40}$/u.test(value)) fail("the canonical remote returned an invalid commit id");
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

export function buildPeerCommand({ root, expected, setupOnly }, config = CONFIG) {
  const merge = setupOnly
    ? ""
    : [
        'git -C "$repo" merge --ff-only "$expected"',
        'test "$(git -C "$repo" rev-parse HEAD)" = "$expected"',
      ].join("\n");
  return [
    "set -eu",
    `repo=${shellQuote(root)}`,
    `remote=${shellQuote(config.remote)}`,
    `branch=${shellQuote(config.branch)}`,
    `remote_url=${shellQuote(config.remoteUrl)}`,
    `expected=${shellQuote(expected || "")}`,
    'test -d "$repo/.git"',
    'test -z "$(git -C "$repo" status --porcelain=v1 --untracked-files=all)"',
    `test "$(git -C "$repo" branch --show-current)" = ${shellQuote(config.branch)}`,
    'if ! git -C "$repo" remote get-url --all "$remote" >/dev/null 2>&1; then git -C "$repo" remote add "$remote" "$remote_url"; fi',
    'test "$(git -C "$repo" remote get-url --all "$remote")" = "$remote_url"',
    'test "$(git -C "$repo" remote get-url --push --all "$remote")" = "$remote_url"',
    'git -C "$repo" fetch "$remote" "$branch"',
    merge,
    'printf "paseo_runtime_commit=%s\\n" "$(git -C "$repo" rev-parse FETCH_HEAD)"',
  ]
    .filter(Boolean)
    .join("\n");
}

export function parsePeerAttestation(output) {
  const match = String(output).match(/(?:^|\n)paseo_runtime_commit=([0-9a-f]{40})\s*$/u);
  if (!match) fail("the peer did not attest its fetched canonical commit");
  return match[1];
}

export function buildReceipt(
  { status, commit, localRoot, peerRoot, localHead, peerAttested },
  config = CONFIG,
) {
  return {
    status,
    remote: config.remote,
    branch: config.branch,
    ...(commit ? { commit } : {}),
    local: localRoot,
    peer: peerRoot,
    ...(localHead ? { localHead } : {}),
    ...(peerAttested ? { peerAttested } : {}),
  };
}

function realRun(command, args, options = {}) {
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

function realGit(root, args) {
  return realRun("git", ["-C", root, ...args]);
}

function realTryGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`could not run git in ${root}: ${result.error.message}`);
  return result.status === 0 ? (result.stdout || "").trim() : null;
}

function peerSsh(kind, command) {
  if (kind === "macbook") {
    return realRun("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "imac",
      "zsh",
      "-lc",
      command,
    ]);
  }
  return realRun("ssh", [
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

export function main() {
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { setupOnly, dryRun } = parseArguments(process.argv.slice(2));
  const { kind, root, peerRoot } = resolvePrimary({ hostname: os.hostname(), root: scriptRoot });
  assertRootOutsidePaseoState(root, path.join(os.homedir(), ".paseo"));
  assertRootOutsidePaseoState(peerRoot, path.join(os.homedir(), ".paseo"));
  assertCleanPrimary(realGit, root);
  assertCanonicalRemote(realGit, realTryGit, root);

  if (setupOnly) {
    peerSsh(kind, buildPeerCommand({ root: peerRoot, expected: null, setupOnly: true }));
    console.log(JSON.stringify(buildReceipt({ status: "configured", localRoot: root, peerRoot })));
    return;
  }

  let expected;
  if (dryRun) {
    expected = assertCommitId(
      realRun("git", [
        "ls-remote",
        "--exit-code",
        CONFIG.remoteUrl,
        `refs/heads/${CONFIG.branch}`,
      ]).split(/\s+/u)[0],
    );
  } else {
    realGit(root, ["fetch", CONFIG.remote, CONFIG.branch]);
    expected = assertCommitId(realGit(root, ["rev-parse", "FETCH_HEAD"]));
    realGit(root, ["merge", "--ff-only", expected]);
  }
  const localHead = realGit(root, ["rev-parse", "HEAD"]);
  if (!dryRun && localHead !== expected) {
    fail(`${root} did not reach the expected canonical commit`);
  }
  const peerAttested = parsePeerAttestation(
    peerSsh(kind, buildPeerCommand({ root: peerRoot, expected, setupOnly: dryRun })),
  );
  if (peerAttested !== expected) {
    fail("the peer fetched a different canonical commit; no source tree was overwritten");
  }
  console.log(
    JSON.stringify(
      buildReceipt({
        status: dryRun ? "verified" : "converged",
        commit: expected,
        localRoot: root,
        peerRoot,
        localHead: dryRun ? undefined : localHead,
        peerAttested,
      }),
    ),
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
