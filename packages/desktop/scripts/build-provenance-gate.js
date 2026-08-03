// Packaging-side enforcement of the exact-source provenance contract defined
// in scripts/build-receipt.cjs at the repo root. run-electron-builder.js runs
// assertWorkspaceExactSource before spawning Electron Builder, and the
// afterPack/afterSign hooks run assertPackagedArchiveExactSource so the bytes
// inside app.asar prove the same commit — a stale server or CLI dist can fail
// only loudly, never ship silently. `read` is the installed readback: point it
// at an installed bundle to prove (and optionally assert) the exact commit a
// signed artifact was built from before activating it.

const fs = require("node:fs");
const path = require("node:path");
const { extractFile } = require("@electron/asar");

const { assertExactSourceReceipts } = require("../../../scripts/build-receipt.cjs");

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const ASAR_RECEIPT_ENTRIES = {
  server: "node_modules/@getpaseo/server/dist/build-receipt.json",
  cli: "node_modules/@getpaseo/cli/dist/build-receipt.json",
};

function assertWorkspaceExactSource({ workspaceRoot }) {
  return assertExactSourceReceipts(workspaceRoot);
}

function readArchiveEntry(archivePath, entryPath) {
  try {
    return extractFile(archivePath, entryPath);
  } catch {
    return null;
  }
}

function assertPackagedArchiveExactSource({ archivePath, workspaceRoot, log = console.log }) {
  const expected = assertExactSourceReceipts(workspaceRoot);
  for (const [packageName, entryPath] of Object.entries(ASAR_RECEIPT_ENTRIES)) {
    const packagedBytes = readArchiveEntry(archivePath, entryPath);
    if (!packagedBytes) {
      throw new Error(
        `Packaged ${path.basename(archivePath)} lacks the exact-source build receipt at ` +
          `${entryPath}; the archive was not packed from the receipted clean build.`,
      );
    }
    if (!packagedBytes.equals(expected.receipts[packageName])) {
      throw new Error(
        `Packaged build receipt at ${entryPath} does not match the clean-build receipt for ` +
          `commit ${expected.commit}; the archive contains stale @getpaseo/${packageName} bytes.`,
      );
    }
  }
  log(
    `[build-provenance] archive=ok commit=${expected.commit} receipts=${Object.keys(ASAR_RECEIPT_ENTRIES).length}`,
  );
  return { commit: expected.commit };
}

function resolveInstalledAsarPath(installedPath) {
  const target = path.resolve(installedPath);
  const candidates = [
    target, // the app.asar file itself
    path.join(target, "Contents", "Resources", "app.asar"), // macOS .app bundle
    path.join(target, "resources", "app.asar"), // Linux/Windows install directory
    path.join(target, "app.asar"), // a resources directory
  ];
  for (const candidate of candidates) {
    if (
      candidate.endsWith(".asar") &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  throw new Error(
    `No app.asar found under ${target}; pass an installed Paseo bundle ` +
      "(.app, install directory, resources directory, or the app.asar itself).",
  );
}

function readInstalledBuildProvenance({ installedPath, expectCommit }) {
  const asarPath = resolveInstalledAsarPath(installedPath);
  const receipts = {};
  let commit = null;
  for (const [packageName, entryPath] of Object.entries(ASAR_RECEIPT_ENTRIES)) {
    const receiptBytes = readArchiveEntry(asarPath, entryPath);
    if (!receiptBytes) {
      throw new Error(
        `Installed bundle carries no build receipt at ${entryPath}; its source commit cannot be proved.`,
      );
    }
    let receipt;
    try {
      receipt = JSON.parse(receiptBytes.toString("utf8"));
    } catch {
      throw new Error(`Installed build receipt at ${entryPath} is not valid JSON.`);
    }
    if (typeof receipt.commit !== "string" || !COMMIT_PATTERN.test(receipt.commit)) {
      throw new Error(`Installed build receipt at ${entryPath} records no usable commit.`);
    }
    if (!Array.isArray(receipt.dirty) || receipt.dirty.length > 0) {
      throw new Error(
        `Installed @getpaseo/${packageName} was built from a dirty tree ` +
          `(${Array.isArray(receipt.dirty) ? receipt.dirty.join(", ") : "unrecorded state"}).`,
      );
    }
    if (commit !== null && receipt.commit !== commit) {
      throw new Error(
        `Installed receipts disagree about the source commit: ${commit} vs ${receipt.commit}.`,
      );
    }
    commit = receipt.commit;
    receipts[packageName] = receipt;
  }
  if (expectCommit !== undefined && commit !== expectCommit) {
    throw new Error(
      `Installed bundle was built from ${commit}, not the expected ${expectCommit}. Do not activate it.`,
    );
  }
  return { asarPath, commit, receipts };
}

function main(argv) {
  const [command, installedPath, ...rest] = argv;
  if (command !== "read" || !installedPath) {
    throw new Error(
      "usage: node build-provenance-gate.js read <installed-app-path> [--expect-commit <sha>]",
    );
  }
  let expectCommit;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--expect-commit" && rest[index + 1]) {
      expectCommit = rest[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${rest[index]}`);
    }
  }
  const provenance = readInstalledBuildProvenance({ installedPath, expectCommit });
  console.log(JSON.stringify(provenance, null, 2));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  ASAR_RECEIPT_ENTRIES,
  assertPackagedArchiveExactSource,
  assertWorkspaceExactSource,
  readInstalledBuildProvenance,
  resolveInstalledAsarPath,
};
