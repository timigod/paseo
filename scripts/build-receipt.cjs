// Exact-source receipts for generated server and CLI artifacts.
// A clean full build writes them. An incremental build invalidates them.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const RECEIPT_BASENAME = "build-receipt.json";
const RECEIPT_PACKAGES = ["server", "cli"];
const DESKTOP_PACKAGE_JSON = "packages/desktop/package.json";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function runGit(workspaceRoot, args) {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${workspaceRoot}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function receiptPath(workspaceRoot, packageName) {
  return path.join(workspaceRoot, "packages", packageName, "dist", RECEIPT_BASENAME);
}

function isVersionOnlyDesktopStamp(workspaceRoot) {
  let head;
  let working;
  try {
    head = JSON.parse(runGit(workspaceRoot, ["show", `HEAD:${DESKTOP_PACKAGE_JSON}`]));
    working = JSON.parse(fs.readFileSync(path.join(workspaceRoot, DESKTOP_PACKAGE_JSON), "utf8"));
  } catch {
    return false;
  }
  return (
    JSON.stringify({ ...head, version: null }) === JSON.stringify({ ...working, version: null })
  );
}

function collectExactSourceState(workspaceRoot) {
  const commit = runGit(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`git rev-parse HEAD returned no usable commit in ${workspaceRoot}: ${commit}`);
  }
  let dirtyPaths = runGit(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  if (dirtyPaths.includes(DESKTOP_PACKAGE_JSON) && isVersionOnlyDesktopStamp(workspaceRoot)) {
    dirtyPaths = dirtyPaths.filter((dirtyPath) => dirtyPath !== DESKTOP_PACKAGE_JSON);
  }
  return { commit, dirtyPaths };
}

function formatBuildReceipt({ commit, dirtyPaths }) {
  return `${JSON.stringify({ commit, dirty: dirtyPaths }, null, 2)}\n`;
}

function writeBuildReceipts(workspaceRoot, log = console.log) {
  const state = collectExactSourceState(workspaceRoot);
  const receiptBytes = formatBuildReceipt(state);
  for (const packageName of RECEIPT_PACKAGES) {
    const target = receiptPath(workspaceRoot, packageName);
    if (!fs.existsSync(path.dirname(target))) {
      throw new Error(
        `Cannot stamp @getpaseo/${packageName}: ${path.dirname(target)} does not exist. ` +
          "Run the full clean build before writing receipts.",
      );
    }
    fs.writeFileSync(target, receiptBytes);
  }
  log(
    `[build-receipt] commit=${state.commit} dirty=${state.dirtyPaths.length} packages=${RECEIPT_PACKAGES.join(",")}`,
  );
  return state;
}

function invalidateBuildReceipts(workspaceRoot) {
  for (const packageName of RECEIPT_PACKAGES) {
    fs.rmSync(receiptPath(workspaceRoot, packageName), { force: true });
  }
}

function assertExactSourceReceipts(workspaceRoot) {
  const state = collectExactSourceState(workspaceRoot);
  if (state.dirtyPaths.length > 0) {
    throw new Error(
      "Desktop packaging requires an exact-source tree, but uncommitted changes exist: " +
        `${state.dirtyPaths.slice(0, 10).join(", ")}. Commit or drop them, then rerun the clean build.`,
    );
  }

  const receipts = {};
  for (const packageName of RECEIPT_PACKAGES) {
    const target = receiptPath(workspaceRoot, packageName);
    if (!fs.existsSync(target)) {
      throw new Error(
        `@getpaseo/${packageName} dist carries no ${RECEIPT_BASENAME}. ` +
          "Run npm run build:server:clean at HEAD before packaging.",
      );
    }
    const receiptBytes = fs.readFileSync(target);
    let receipt;
    try {
      receipt = JSON.parse(receiptBytes.toString("utf8"));
    } catch {
      throw new Error(`${target} is not valid JSON. Rerun npm run build:server:clean.`);
    }
    if (receipt.commit !== state.commit) {
      throw new Error(
        `stale dist: @getpaseo/${packageName} was built from ${receipt.commit ?? "an unknown commit"}, ` +
          `but HEAD is ${state.commit}. Run npm run build:server:clean before packaging.`,
      );
    }
    if (!Array.isArray(receipt.dirty) || receipt.dirty.length > 0) {
      throw new Error(
        `@getpaseo/${packageName} was built from a dirty tree ` +
          `(${Array.isArray(receipt.dirty) ? receipt.dirty.join(", ") : "unrecorded state"}). ` +
          "Rebuild from a clean checkout.",
      );
    }
    receipts[packageName] = receiptBytes;
  }
  return { commit: state.commit, receipts };
}

function main(argv) {
  const [command, explicitRoot] = argv;
  const workspaceRoot = explicitRoot ? path.resolve(explicitRoot) : path.resolve(__dirname, "..");
  if (command === "write") {
    writeBuildReceipts(workspaceRoot);
    return;
  }
  if (command === "invalidate") {
    invalidateBuildReceipts(workspaceRoot);
    return;
  }
  if (command === "assert") {
    const { commit } = assertExactSourceReceipts(workspaceRoot);
    console.log(`[build-receipt] exact-source=ok commit=${commit}`);
    return;
  }
  throw new Error(
    "usage: node scripts/build-receipt.cjs <write|invalidate|assert> [workspaceRoot]",
  );
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
  DESKTOP_PACKAGE_JSON,
  RECEIPT_BASENAME,
  RECEIPT_PACKAGES,
  assertExactSourceReceipts,
  collectExactSourceState,
  formatBuildReceipt,
  invalidateBuildReceipts,
  receiptPath,
  writeBuildReceipts,
};
