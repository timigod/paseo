import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONFIG,
  assertCanonicalRemote,
  assertCleanPrimary,
  assertCommitId,
  assertRootOutsidePaseoState,
  buildPeerCommand,
  buildReceipt,
  parseArguments,
  parsePeerAttestation,
  resolvePrimary,
} from "./converge-runtime-source.mjs";

const SHA = "a".repeat(40);

test("pins the canonical primaries, fork remote, and runtime branch", () => {
  assert.equal(CONFIG.primaries.macbook.root, "/Users/timiajiboye/Code/paseo");
  assert.equal(CONFIG.primaries.imac.root, "/Users/timi/Code/paseo");
  assert.equal(CONFIG.remoteUrl, "https://github.com/timigod/paseo.git");
  assert.equal(CONFIG.remote, "paseo-runtime");
  assert.equal(CONFIG.branch, "runtime/stable");
});

test("resolves each declared host to its canonical primary and peer", () => {
  const macbook = resolvePrimary({
    hostname: "Timis-MacBook-Pro.local",
    root: "/Users/timiajiboye/Code/paseo",
  });
  assert.equal(macbook.kind, "macbook");
  assert.equal(macbook.peerRoot, "/Users/timi/Code/paseo");
  const imac = resolvePrimary({ hostname: "iMac.local", root: "/Users/timi/Code/paseo" });
  assert.equal(imac.kind, "imac");
  assert.equal(imac.peerRoot, "/Users/timiajiboye/Code/paseo");
});

test("refuses undeclared hosts and non-canonical roots", () => {
  assert.throws(
    () => resolvePrimary({ hostname: "build-runner.local", root: "/Users/timiajiboye/Code/paseo" }),
    /not a declared Paseo runtime host/,
  );
  assert.throws(
    () =>
      resolvePrimary({
        hostname: "Timis-MacBook-Pro.local",
        root: "/Users/timiajiboye/.paseo/worktrees/abc/feature",
      }),
    /clean canonical primary checkout/,
  );
});

test("refuses any root inside the Paseo state directory", () => {
  assert.throws(
    () =>
      assertRootOutsidePaseoState(
        "/Users/timiajiboye/.paseo/worktrees/abc/repo",
        "/Users/timiajiboye/.paseo",
      ),
    /never touches ~\/.paseo state/,
  );
  assertRootOutsidePaseoState("/Users/timiajiboye/Code/paseo", "/Users/timiajiboye/.paseo");
});

test("refuses a dirty primary and a primary off the runtime branch", () => {
  const dirty = (_root, args) => (args[0] === "status" ? " M packages/server/src/x.ts" : "");
  assert.throws(() => assertCleanPrimary(dirty, "/Users/timiajiboye/Code/paseo"), /dirty/);
  const wrongBranch = (_root, args) => (args[0] === "status" ? "" : "main");
  assert.throws(
    () => assertCleanPrimary(wrongBranch, "/Users/timiajiboye/Code/paseo"),
    /not the runtime branch 'runtime\/stable'/,
  );
  const clean = (_root, args) => (args[0] === "status" ? "" : "runtime/stable");
  assertCleanPrimary(clean, "/Users/timiajiboye/Code/paseo");
});

test("requires exactly one canonical fork URL for fetch and push", () => {
  const wrongUrl = (_root, _args) => "https://github.com/getpaseo/paseo.git";
  assert.throws(
    () => assertCanonicalRemote(wrongUrl, () => "anything", "/Users/timiajiboye/Code/paseo"),
    /must have exactly one paseo-runtime/,
  );
  const twoUrls = (_root, _args) =>
    "https://github.com/timigod/paseo.git\nhttps://github.com/other/paseo.git";
  assert.throws(
    () => assertCanonicalRemote(twoUrls, () => "anything", "/Users/timiajiboye/Code/paseo"),
    /must have exactly one paseo-runtime/,
  );
  const calls = [];
  const canonical = (_root, args) => {
    calls.push(args);
    return args[0] === "remote" && args[1] === "add" ? "" : "https://github.com/timigod/paseo.git";
  };
  assertCanonicalRemote(canonical, () => null, "/Users/timiajiboye/Code/paseo");
  assert.deepEqual(calls[0], [
    "remote",
    "add",
    "paseo-runtime",
    "https://github.com/timigod/paseo.git",
  ]);
});

test("peer command converges by clean fast-forward only and never touches ~/.paseo", () => {
  const command = buildPeerCommand({
    root: "/Users/timi/Code/paseo",
    expected: SHA,
    setupOnly: false,
  });
  assert.match(command, /repo='\/Users\/timi\/Code\/paseo'/);
  assert.match(command, /status --porcelain=v1 --untracked-files=all/);
  assert.match(command, /branch --show-current.*runtime\/stable/);
  assert.match(command, /merge --ff-only/);
  assert.match(command, /fetch "\$remote" "\$branch"/);
  assert.match(command, /paseo_runtime_commit=/);
  assert.ok(!command.includes(".paseo"), "peer command must never reference ~/.paseo state");
  const setupCommand = buildPeerCommand({
    root: "/Users/timi/Code/paseo",
    expected: null,
    setupOnly: true,
  });
  assert.ok(!setupCommand.includes("merge --ff-only"));
  assert.ok(!setupCommand.includes(".paseo"));
});

test("requires an exact peer commit attestation", () => {
  assert.equal(parsePeerAttestation(`noise\npaseo_runtime_commit=${SHA}\n`), SHA);
  assert.throws(() => parsePeerAttestation("converged fine, trust me"), /did not attest/);
  assert.throws(() => parsePeerAttestation("paseo_runtime_commit=deadbeef"), /did not attest/);
});

test("accepts only full commit ids from the canonical remote", () => {
  assert.equal(assertCommitId(SHA), SHA);
  assert.throws(() => assertCommitId("HEAD"), /invalid commit id/);
  assert.throws(() => assertCommitId(""), /invalid commit id/);
});

test("rejects unknown or combined arguments", () => {
  assert.deepEqual(parseArguments(["--dry-run"]), { setupOnly: false, dryRun: true });
  assert.throws(() => parseArguments(["--force"]), /unknown argument/);
  assert.throws(() => parseArguments(["--setup-only", "--dry-run"]), /cannot be combined/);
});

test("dry-run receipt attests the exact remote commit on both hosts", () => {
  const receipt = buildReceipt({
    status: "verified",
    commit: SHA,
    localRoot: "/Users/timiajiboye/Code/paseo",
    peerRoot: "/Users/timi/Code/paseo",
    peerAttested: SHA,
  });
  assert.deepEqual(receipt, {
    status: "verified",
    remote: "paseo-runtime",
    branch: "runtime/stable",
    commit: SHA,
    local: "/Users/timiajiboye/Code/paseo",
    peer: "/Users/timi/Code/paseo",
    peerAttested: SHA,
  });
});

test("converged receipt records the fast-forwarded local head", () => {
  const receipt = buildReceipt({
    status: "converged",
    commit: SHA,
    localRoot: "/Users/timiajiboye/Code/paseo",
    peerRoot: "/Users/timi/Code/paseo",
    localHead: SHA,
    peerAttested: SHA,
  });
  assert.equal(receipt.status, "converged");
  assert.equal(receipt.localHead, SHA);
  assert.equal(receipt.peerAttested, SHA);
});
