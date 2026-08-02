import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { copyFile, lstat, readdir, rename, stat, writeFile } from "fs/promises";
import { join, basename, dirname, isAbsolute, relative, resolve, sep } from "path";
import { spawn } from "node:child_process";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import stripAnsi from "strip-ansi";
import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnv,
} from "./string-command-shell.js";
import { readPaseoConfigJson, resolvePaseoConfigPath } from "./paseo-config-file.js";
export {
  PaseoConfigRawSchema,
  PaseoLifecycleCommandRawSchema,
  PaseoScriptEntryRawSchema,
  PaseoWorktreeConfigRawSchema,
  PaseoConfigSchema,
  type PaseoConfig,
  type PaseoConfigRaw,
} from "@getpaseo/protocol/paseo-config-schema";
import { PaseoConfigSchema, type PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import {
  ensurePaseoWorktreeIncarnationId,
  normalizeBaseRefName,
  type PaseoWorktreeChangeRequestLookupTarget,
  readPaseoWorktreeIncarnationId,
  readPaseoWorktreeMetadata,
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runGitCommand } from "./run-git-command.js";
import { spawnProcess } from "./spawn.js";
import { terminateWithTreeKill } from "./tree-kill.js";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { createExternalProcessEnv } from "../server/paseo-env.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import { expandTilde, getRealpathAwareRelativePath, isPathInsideRoot } from "./path.js";
import { findExecutable as findExecutableOnPath } from "../executable-resolution/executable-resolution.js";
import {
  appendWorktreeSetupOutput,
  createWorktreeSetupOutputAccumulator,
  getWorktreeSetupCommandOutputLimit,
  renderWorktreeSetupOutput,
} from "./worktree-setup-output.js";

export { slugify, validateBranchSlug } from "@getpaseo/protocol/branch-slug";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;
const WORKTREE_CLEANUP_MARKER_PREFIX = ".paseo-cleanup-marker-";
const WORKTREE_CLEANUP_COMPLETED_MARKER_PREFIX = ".paseo-cleanup-completed-";
const WORKTREE_CLEANUP_RECOVERY_ROOT_NAME = ".paseo-cleanup-recovery";
const WORKTREE_CLEANUP_RECEIPT_PREFIX = ".paseo-cleanup-receipt-";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSIX_CLEANUP_READY = "PASEO_CLEANUP_READY";
const POSIX_CLEANUP_COMPLETED = "PASEO_CLEANUP_COMPLETED";
const POSIX_CLEANUP_DONE = "PASEO_CLEANUP_DONE ";
const DEFAULT_CLEANUP_HELPER_TIMEOUT_MS = 120_000;
const POSIX_PINNED_CLEANUP_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const expectedIdentity = process.argv[1];
const activeMarkerName = process.argv[2];
const completedMarkerName = process.argv[3];
const trustedParent = process.argv[4];
const recoveryRoot = process.argv[5];
const expectedRecoveryRootIdentity = process.argv[6];
const receiptPath = process.argv[7];
const traversalKind = process.argv[8];
const findExecutable = process.argv[9];
const findArguments = JSON.parse(process.argv[10]);
const faultPoint = process.argv[11] || null;
const pinnedPath = process.cwd();
const startsInReceipt = pinnedPath === receiptPath;

function fail(kind, message) {
  process.stderr.write(kind + ":" + message + "\n");
  process.exit(1);
}

function markerIsFile(markerName) {
  try {
    return fs.lstatSync(markerName).isFile();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function readMarkerState(allowEmptyReceipt) {
  const hasActiveMarker = markerIsFile(activeMarkerName);
  const hasCompletedMarker = markerIsFile(completedMarkerName);
  if (!hasActiveMarker && !hasCompletedMarker && allowEmptyReceipt && fs.readdirSync(".").length === 0) {
    return "empty";
  }
  if (hasActiveMarker === hasCompletedMarker) {
    fail("AUTHORITY", "Pinned cleanup quarantine marker changed");
  }
  return hasActiveMarker ? "active" : "completed";
}

function validatePinnedDirectory(entryPath, expectedParent, allowEmptyReceipt) {
  if (path.dirname(entryPath) !== expectedParent) {
    fail("AUTHORITY", "Pinned cleanup directory left its trusted parent");
  }
  const pinnedStats = fs.lstatSync(".");
  const pinnedIdentity = String(pinnedStats.dev) + ":" + String(pinnedStats.ino);
  if (!pinnedStats.isDirectory() || pinnedIdentity !== expectedIdentity) {
    fail("AUTHORITY", "Pinned cleanup directory identity changed");
  }
  let entryStats;
  try {
    entryStats = fs.lstatSync(entryPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fail("AUTHORITY", "Pinned cleanup directory lost its trusted pathname");
    }
    throw error;
  }
  const entryIdentity = String(entryStats.dev) + ":" + String(entryStats.ino);
  if (!entryStats.isDirectory() || entryIdentity !== expectedIdentity) {
    fail("AUTHORITY", "Cleanup path identity changed for " + entryPath);
  }
  return readMarkerState(allowEmptyReceipt);
}

function failAt(point) {
  if (faultPoint !== point) return;
  fail("FAULT", point);
}

function decodeLinuxMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function readLinuxMountPoints() {
  if (process.platform !== "linux") return [];
  let mountInfo;
  try {
    mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch (error) {
    fail("BOUNDARY", "Linux mount identity is unavailable: " + error.message);
  }
  return mountInfo
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[4])
    .filter(Boolean)
    .map(decodeLinuxMountPath)
    .map((mountPoint) => path.resolve(mountPoint));
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function assertLinuxMountIdentity() {
  const mountPoints = readLinuxMountPoints();
  if (mountPoints.includes(path.resolve(recoveryRoot))) {
    fail("BOUNDARY", "Cleanup recovery root is a Linux mount point");
  }
  if (!startsInReceipt) {
    if (mountPoints.includes(path.resolve(pinnedPath))) {
      fail("BOUNDARY", "Cleanup quarantine is a Linux mount point");
    }
    const nestedMount = mountPoints.find((mountPoint) => isPathInside(pinnedPath, mountPoint));
    if (nestedMount) {
      fail("BOUNDARY", "Refusing to cross a Linux mount boundary at " + nestedMount);
    }
  }
}

function validateRecoveryRoot() {
  const stats = fs.lstatSync(recoveryRoot);
  const identity = String(stats.dev) + ":" + String(stats.ino);
  const pinnedStats = fs.lstatSync(".");
  const expectedRealpath = path.join(
    fs.realpathSync(path.dirname(recoveryRoot)),
    path.basename(recoveryRoot),
  );
  if (
    !stats.isDirectory() ||
    identity !== expectedRecoveryRootIdentity ||
    stats.dev !== pinnedStats.dev ||
    fs.realpathSync(recoveryRoot) !== expectedRealpath ||
    path.dirname(receiptPath) !== recoveryRoot
  ) {
    fail("AUTHORITY", "Cleanup recovery root identity changed");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    fail("AUTHORITY", "Cleanup recovery root owner changed");
  }
  if ((stats.mode & 0o777) !== 0o700) {
    fail("AUTHORITY", "Cleanup recovery root permissions changed");
  }
  assertLinuxMountIdentity();
}

function runBoundedTraversal() {
  if (traversalKind !== "posix-find") {
    fail("BOUNDARY", "Recursive cleanup is unsupported on this platform");
  }
  assertLinuxMountIdentity();
  const result = spawnSync(findExecutable, findArguments, {
    cwd: ".",
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : result.stderr.trim();
    fail("REMOVE", detail || "Filesystem-bounded removal helper failed");
  }
}

function beginRemoval() {
  const initialPath = startsInReceipt ? receiptPath : pinnedPath;
  const initialParent = startsInReceipt ? recoveryRoot : trustedParent;
  const initialMarkerState = validatePinnedDirectory(initialPath, initialParent, startsInReceipt);
  validateRecoveryRoot();
  if (startsInReceipt) {
    if (initialMarkerState === "active") {
      fail("AUTHORITY", "Cleanup receipt has an active marker");
    }
    process.stdout.write(${JSON.stringify(`${POSIX_CLEANUP_COMPLETED}\n`)});
    phase = "relocate";
    return;
  }
  runBoundedTraversal();
  validatePinnedDirectory(pinnedPath, trustedParent, false);
  const expectedMarker = initialMarkerState === "active" ? activeMarkerName : completedMarkerName;
  const entries = fs.readdirSync(".");
  if (entries.length !== 1 || entries[0] !== expectedMarker) {
    fail("REMOVE", "Pinned cleanup directory did not become marker-only");
  }
  if (initialMarkerState === "active") {
    failAt("before-marker-removal");
    fs.renameSync(activeMarkerName, completedMarkerName);
    failAt("after-marker-removal");
  }
  if (validatePinnedDirectory(pinnedPath, trustedParent, false) !== "completed") {
    fail("AUTHORITY", "Pinned cleanup completion marker changed");
  }
  const completedEntries = fs.readdirSync(".");
  if (completedEntries.length !== 1 || completedEntries[0] !== completedMarkerName) {
    fail("REMOVE", "Pinned cleanup directory did not remain marker-only");
  }
  process.stdout.write(${JSON.stringify(`${POSIX_CLEANUP_COMPLETED}\n`)});
  phase = "relocate";
}

function relocateAndFinalize() {
  validateRecoveryRoot();
  if (!startsInReceipt) {
    if (validatePinnedDirectory(pinnedPath, trustedParent, false) !== "completed") {
      fail("AUTHORITY", "Pinned cleanup completion marker changed");
    }
    const entries = fs.readdirSync(".");
    if (entries.length !== 1 || entries[0] !== completedMarkerName) {
      fail("REMOVE", "Pinned cleanup directory did not remain marker-only");
    }
    fs.renameSync(pinnedPath, receiptPath);
    validatePinnedDirectory(receiptPath, recoveryRoot, false);
    try {
      fs.lstatSync(pinnedPath);
      fail("AUTHORITY", "Cleanup quarantine pathname remained after receipt relocation");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  } else {
    validatePinnedDirectory(receiptPath, recoveryRoot, true);
  }
  failAt("before-completion-acknowledgement");
  const markerState = readMarkerState(true);
  if (markerState === "completed") {
    fs.unlinkSync(completedMarkerName);
  } else if (markerState !== "empty") {
    fail("AUTHORITY", "Cleanup receipt completion marker changed");
  }
  const finalStats = fs.lstatSync(".");
  const finalIdentity = String(finalStats.dev) + ":" + String(finalStats.ino);
  if (finalIdentity !== expectedIdentity || fs.readdirSync(".").length !== 0) {
    fail("AUTHORITY", "Cleanup receipt did not become authenticated and empty");
  }
  validateRecoveryRoot();
  const receiptStats = fs.lstatSync(receiptPath);
  const receiptIdentity = String(receiptStats.dev) + ":" + String(receiptStats.ino);
  if (!receiptStats.isDirectory() || receiptIdentity !== expectedIdentity) {
    fail("AUTHORITY", "Cleanup receipt identity changed before removal");
  }
  fs.rmdirSync(receiptPath);
  try {
    fs.lstatSync(receiptPath);
    fail("AUTHORITY", "Cleanup receipt remained after removal");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  process.stdout.write(${JSON.stringify(POSIX_CLEANUP_DONE)} + JSON.stringify(receiptPath) + "\n");
  process.exit(0);
}

validatePinnedDirectory(
  startsInReceipt ? receiptPath : pinnedPath,
  startsInReceipt ? recoveryRoot : trustedParent,
  startsInReceipt,
);
validateRecoveryRoot();
process.stdout.write(${JSON.stringify(`${POSIX_CLEANUP_READY}\n`)});
process.stdin.setEncoding("utf8");
let command = "";
let phase = "remove";
process.stdin.on("data", (chunk) => {
  command += chunk;
  let newlineIndex = command.indexOf("\n");
  while (newlineIndex !== -1) {
    const nextCommand = command.slice(0, newlineIndex);
    command = command.slice(newlineIndex + 1);
    if (phase === "remove" && nextCommand === "REMOVE") {
      beginRemoval();
    } else if (phase === "relocate" && nextCommand === "RELOCATE") {
      phase = "done";
      relocateAndFinalize();
    } else {
      fail("AUTHORITY", "Invalid pinned cleanup command");
    }
    newlineIndex = command.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (phase !== "done") fail("AUTHORITY", "Pinned cleanup command was not received");
});
`;

let posixFindExecutablePromise: Promise<string> | null = null;

export type WorktreeCleanupFaultPoint =
  | "before-marker-removal"
  | "after-marker-removal"
  | "before-completion-acknowledgement";

export type WorktreeCleanupTraversalContract =
  | { kind: "windows-unsupported" }
  | { kind: "posix-find"; boundaryArgument: "-x" | "-xdev" };

export function getWorktreeCleanupTraversalContract(
  platform: NodeJS.Platform,
): WorktreeCleanupTraversalContract {
  if (platform === "win32") return { kind: "windows-unsupported" };
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") {
    return { kind: "posix-find", boundaryArgument: "-x" };
  }
  if (
    platform === "linux" ||
    platform === "aix" ||
    platform === "android" ||
    platform === "sunos"
  ) {
    return { kind: "posix-find", boundaryArgument: "-xdev" };
  }
  throw new Error(`Filesystem-bounded cleanup is unsupported on ${platform}`);
}

function decodeLinuxMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseLinuxMountPoints(mountInfo: string): string[] {
  return mountInfo.split("\n").flatMap((line) => {
    const mountPoint = line.split(" ")[4];
    return mountPoint ? [resolve(decodeLinuxMountPath(mountPoint))] : [];
  });
}

export function findNestedLinuxMountPoints(mountInfo: string, cleanupPath: string): string[] {
  const resolvedCleanupPath = resolve(cleanupPath);
  return parseLinuxMountPoints(mountInfo).filter((mountPoint) => {
    const relativeMountPoint = relative(resolvedCleanupPath, mountPoint);
    return (
      relativeMountPoint !== "" &&
      relativeMountPoint !== ".." &&
      !relativeMountPoint.startsWith(`..${sep}`) &&
      !isAbsolute(relativeMountPoint)
    );
  });
}

export function getWorktreeCleanupFindArguments(
  platform: NodeJS.Platform,
  activeMarkerName: string,
  completedMarkerName: string,
): string[] {
  const contract = getWorktreeCleanupTraversalContract(platform);
  if (contract.kind !== "posix-find") {
    throw new Error(`POSIX cleanup traversal is unavailable on ${platform}`);
  }
  const expression = [
    "!",
    "-path",
    ".",
    "!",
    "-path",
    `./${activeMarkerName}`,
    "!",
    "-path",
    `./${completedMarkerName}`,
    "-delete",
  ];
  return contract.boundaryArgument === "-x"
    ? ["-P", "-x", ".", ...expression]
    : ["-P", ".", "-xdev", ...expression];
}

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
}

export interface WorktreeRuntimeEnv {
  [key: string]: string;
  PASEO_SOURCE_CHECKOUT_PATH: string;
  PASEO_ROOT_PATH: string;
  PASEO_WORKTREE_PATH: string;
  PASEO_BRANCH_NAME: string;
  PASEO_WORKTREE_PORT: string;
}

export interface WorktreeSetupCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export type WorktreeSetupCommandProgressEvent =
  | {
      type: "command_started";
      index: number;
      total: number;
      command: string;
      cwd: string;
    }
  | {
      type: "output";
      index: number;
      total: number;
      command: string;
      cwd: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "command_completed";
      index: number;
      total: number;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
    };

export interface WorktreeTerminalConfig {
  name?: string;
  command: string;
}

export interface PlainScriptConfig {
  type?: undefined;
  command: string;
  port?: undefined;
}

export interface ServiceScriptConfig {
  type: "service";
  command: string;
  port?: number; // explicit port override, otherwise auto-assigned
}

export type ScriptConfig = PlainScriptConfig | ServiceScriptConfig;

export function isServiceScript(config: ScriptConfig): config is ServiceScriptConfig {
  return "type" in config && config.type === "service";
}

export class WorktreeSetupError extends Error {
  readonly results: WorktreeSetupCommandResult[];

  constructor(message: string, results: WorktreeSetupCommandResult[]) {
    super(message);
    this.name = "WorktreeSetupError";
    this.results = results;
  }
}

export type WorktreeTeardownCommandResult = WorktreeSetupCommandResult;

export class WorktreeTeardownError extends Error {
  readonly results: WorktreeTeardownCommandResult[];

  constructor(message: string, results: WorktreeTeardownCommandResult[]) {
    super(message);
    this.name = "WorktreeTeardownError";
    this.results = results;
  }
}

export interface PaseoWorktreeInfo {
  path: string;
  createdAt: string;
  branchName?: string;
  head?: string;
}

export interface PaseoWorktreeOwnership {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
}

export interface PaseoWorktreeOwnershipOptions extends WorktreeRootOptions {
  knownGitCommonDir?: string | null;
}

export interface WorktreeRootOptions {
  paseoHome?: string;
  worktreesRoot?: string;
}

export interface WorktreeCheckoutRef {
  remoteName?: string;
  remoteRef: string;
}

export type WorktreeSource =
  | { kind: "branch-off"; baseBranch: string; branchName: string }
  | { kind: "checkout-branch"; branchName: string }
  | {
      kind: "checkout-change-request";
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
  | {
      kind: "checkout-github-pr";
      githubPrNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    };

export interface CreateWorktreeOptions {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  runSetup: boolean;
  paseoHome?: string;
  worktreesRoot?: string;
  onWorktreePathPlanned?: (worktreePath: string, plan: WorktreeCreationPlan) => Promise<void>;
  onWorktreePathResolved?: (
    worktreePath: string,
    reservation: WorktreeCreationReservation,
  ) => Promise<void>;
}

export interface WorktreeCreationPlan {
  worktreeIncarnationId: string;
  metadataBaseRefName: string;
}

export interface WorktreeCreationReservation {
  worktreeIncarnationId: string;
  directoryIdentity: {
    device: string;
    inode: string;
  };
  metadataBaseRefName: string;
}

export interface WorktreeCreationJournalCallbacks {
  onWorktreePathPlanned: (worktreePath: string, plan: WorktreeCreationPlan) => Promise<void>;
  onWorktreePathResolved: (
    worktreePath: string,
    reservation: WorktreeCreationReservation,
  ) => Promise<void>;
}

const WORKTREE_CREATION_MARKER_FILENAME = ".paseo-worktree-creation";

export function readWorktreeCreationMarker(worktreePath: string): string | null {
  try {
    return readFileSync(join(worktreePath, WORKTREE_CREATION_MARKER_FILENAME), "utf8").trim();
  } catch {
    return null;
  }
}

interface ResolveExistingWorktreeForSlugOptions {
  slug: string;
  repoRoot: string;
  paseoHome?: string;
  worktreesRoot?: string;
}

export class BranchAlreadyCheckedOutError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Branch already checked out: ${branchName}`);
    this.name = "BranchAlreadyCheckedOutError";
    this.branchName = branchName;
  }
}

export class UnknownBranchError extends Error {
  readonly branchName: string;
  readonly cwd: string;

  constructor(params: { branchName: string; cwd: string }) {
    super(`Unknown branch: ${params.branchName}`);
    this.name = "UnknownBranchError";
    this.branchName = params.branchName;
    this.cwd = params.cwd;
  }
}

export class InvalidGitBranchNameError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Invalid branch name: Git rejected ref name '${branchName}'`);
    this.name = "InvalidGitBranchNameError";
    this.branchName = branchName;
  }
}

export type ReadPaseoConfigResult =
  | { ok: true; config: PaseoConfig | null }
  | { ok: false; configPath: string; error: unknown };

export function readPaseoConfig(repoRoot: string): ReadPaseoConfigResult {
  try {
    const json = readPaseoConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null };
    }
    return { ok: true, config: PaseoConfigSchema.parse(json) };
  } catch (error) {
    return { ok: false, configPath: resolvePaseoConfigPath(repoRoot), error };
  }
}

export function paseoConfigParseError(failure: { configPath: string; error: unknown }): Error {
  const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return new Error(`Failed to parse paseo.json at ${failure.configPath}: ${detail}`, {
    cause: failure.error,
  });
}

function readPaseoConfigOrThrow(repoRoot: string): PaseoConfig | null {
  const result = readPaseoConfig(repoRoot);
  if (!result.ok) {
    throw paseoConfigParseError(result);
  }
  return result.config;
}

export function getWorktreeSetupCommands(repoRoot: string): string[] {
  return readPaseoConfigOrThrow(repoRoot)?.worktree?.setup ?? [];
}

export function getWorktreeTeardownCommands(repoRoot: string): string[] {
  return readPaseoConfigOrThrow(repoRoot)?.worktree?.teardown ?? [];
}

export function getWorktreeTerminalSpecs(repoRoot: string): WorktreeTerminalConfig[] {
  const terminals = readPaseoConfigOrThrow(repoRoot)?.worktree?.terminals;
  if (!Array.isArray(terminals) || terminals.length === 0) {
    return [];
  }

  const specs: WorktreeTerminalConfig[] = [];
  for (const terminal of terminals) {
    if (!terminal || typeof terminal !== "object") {
      continue;
    }

    const rawCommand = terminal.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const rawName = terminal.name;
    const name =
      typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : undefined;

    specs.push({
      ...(name ? { name } : {}),
      command,
    });
  }

  return specs;
}

export function getScriptConfigs(config: PaseoConfig | null): Map<string, ScriptConfig> {
  const scripts = config?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return new Map();
  }

  const result = new Map<string, ScriptConfig>();
  for (const [name, entry] of Object.entries(scripts)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const rawCommand = entry.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const scriptConfig: ScriptConfig =
      entry.type === "service"
        ? {
            type: "service",
            command,
          }
        : { command };

    if (
      isServiceScript(scriptConfig) &&
      typeof entry.port === "number" &&
      Number.isFinite(entry.port)
    ) {
      scriptConfig.port = entry.port;
    }

    result.set(name, scriptConfig);
  }

  return result;
}

export function processCarriageReturns(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }

  const output: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const flushLine = () => {
    output.push(line.join(""));
    line = [];
    cursor = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        flushLine();
        output.push("\n");
        index += 1;
        continue;
      }
      cursor = 0;
      continue;
    }

    if (char === "\n") {
      flushLine();
      output.push("\n");
      continue;
    }

    if (cursor < line.length) {
      line[cursor] = char;
    } else {
      line.push(char);
    }
    cursor += 1;
  }

  if (line.length > 0) {
    output.push(line.join(""));
  }

  return output.join("");
}

async function execSetupCommandStreamed(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  index: number;
  total: number;
  maxOutputBytes: number;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<WorktreeSetupCommandResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const stdoutAccumulator = createWorktreeSetupOutputAccumulator(options.maxOutputBytes);
    const stderrAccumulator = createWorktreeSetupOutputAccumulator(options.maxOutputBytes);
    let settled = false;

    const emitOutput = (stream: "stdout" | "stderr", chunk: string) => {
      const text = stripAnsi(chunk);
      if (!text) {
        return;
      }
      if (stream === "stdout") {
        appendWorktreeSetupOutput(stdoutAccumulator, text);
      } else {
        appendWorktreeSetupOutput(stderrAccumulator, text);
      }
      options.onEvent?.({
        type: "output",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        stream,
        chunk: text,
      });
    };

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", abortCommand);
      const combinedBytes = stdoutAccumulator.totalBytes + stderrAccumulator.totalBytes;
      const stdoutOutputBytes =
        combinedBytes === 0
          ? 0
          : Math.floor((options.maxOutputBytes * stdoutAccumulator.totalBytes) / combinedBytes);
      const stderrOutputBytes = options.maxOutputBytes - stdoutOutputBytes;
      const stdout = renderWorktreeSetupOutput(stdoutAccumulator, stdoutOutputBytes).text;
      const stderr = renderWorktreeSetupOutput(stderrAccumulator, stderrOutputBytes).text;
      const result: WorktreeSetupCommandResult = {
        command: options.command,
        cwd: options.cwd,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
      };
      options.onEvent?.({
        type: "command_completed",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      resolvePromise(result);
    };

    options.onEvent?.({
      type: "command_started",
      index: options.index,
      total: options.total,
      command: options.command,
      cwd: options.cwd,
    });

    const shellInvocation = buildStringCommandShellInvocation({ command: options.command });
    const child = spawnProcess(shellInvocation.shell, shellInvocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abortCommand = () => {
      emitOutput("stderr", "Worktree lifecycle command canceled");
      void terminateWithTreeKill(child, {
        gracefulTimeoutMs: 1_000,
        forceTimeoutMs: 1_000,
      }).finally(() => finish(null));
    };
    options.signal?.addEventListener("abort", abortCommand, { once: true });
    if (options.signal?.aborted) abortCommand();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      emitOutput("stdout", chunk.toString());
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      emitOutput("stderr", chunk.toString());
    });

    child.on("error", (error) => {
      emitOutput("stderr", error instanceof Error ? error.message : String(error));
      finish(null);
    });

    child.on("close", (code) => {
      finish(typeof code === "number" ? code : null);
    });
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire available port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      let message: string;
      if (error?.code === "EADDRINUSE") {
        message = `Persisted worktree port ${port} is already in use`;
      } else if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      reject(new Error(message));
    });
    server.listen(port, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  });
}

async function inferRepoRootPathFromWorktreePath(worktreePath: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(worktreePath);
    const normalizedCommonDir = normalizePathForOwnership(commonDir);
    // Normal repo/worktree: common dir is <repoRoot>/.git
    if (basename(normalizedCommonDir) === ".git") {
      return dirname(normalizedCommonDir);
    }
    // Bare repo: common dir is the repo dir itself
    return normalizedCommonDir;
  } catch {
    // Fallback: best-effort resolve toplevel (will be the worktree root in typical cases)
    try {
      const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: worktreePath,
        envOverlay: READ_ONLY_GIT_ENV,
      });
      const topLevel = parseGitRevParsePath(stdout);
      if (topLevel) {
        return normalizePathForOwnership(topLevel);
      }
    } catch {
      // ignore
    }
    return normalizePathForOwnership(worktreePath);
  }
}

export async function runWorktreeSetupCommands(options: {
  worktreePath: string;
  branchName: string;
  cleanupOnFailure: boolean;
  repoRootPath?: string;
  runtimeEnv?: WorktreeRuntimeEnv;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult[]> {
  // Read paseo.json from the worktree (it will have the same content as the source repo)
  const setupCommands = getWorktreeSetupCommands(options.worktreePath);
  if (setupCommands.length === 0) {
    return [];
  }

  const runtimeEnv =
    options.runtimeEnv ??
    (await resolveWorktreeRuntimeEnv({
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      ...(options.repoRootPath ? { repoRootPath: options.repoRootPath } : {}),
    }));
  const setupEnv = createStringCommandShellEnv(createExternalProcessEnv(process.env, runtimeEnv));

  const results: WorktreeSetupCommandResult[] = [];
  const maxOutputBytes = getWorktreeSetupCommandOutputLimit(setupCommands.length);
  for (const [index, cmd] of setupCommands.entries()) {
    const result = await execSetupCommandStreamed({
      command: cmd,
      cwd: options.worktreePath,
      env: setupEnv,
      index: index + 1,
      total: setupCommands.length,
      maxOutputBytes,
      onEvent: options.onEvent,
    });
    results.push(result);

    if (result.exitCode !== 0) {
      if (options.cleanupOnFailure) {
        try {
          await runGitCommand(["worktree", "remove", options.worktreePath, "--force"], {
            cwd: options.worktreePath,
            timeout: 120_000,
          });
        } catch {
          rmSync(options.worktreePath, { recursive: true, force: true });
        }
      }
      throw new WorktreeSetupError(
        `Worktree setup command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

async function resolveBranchNameForWorktreePath(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], {
      cwd: worktreePath,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const branchName = stdout.trim();
    if (branchName.length > 0) {
      return branchName;
    }
  } catch {
    // ignore
  }

  return basename(worktreePath);
}

export async function resolveWorktreeRuntimeEnv(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeRuntimeEnv> {
  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));

  let worktreePort = readPaseoWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = readPaseoWorktreeMetadata(options.worktreePath);
    if (metadata) {
      writePaseoWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
    }
  } else {
    await assertPortAvailable(worktreePort);
  }

  return {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows setup scripts to copy local files (e.g. .env) from the
    // source checkout.
    PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    PASEO_ROOT_PATH: repoRootPath,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: branchName,
    PASEO_WORKTREE_PORT: String(worktreePort),
  };
}

export async function runWorktreeTeardownCommands(options: {
  worktreePath: string;
  teardownCwd?: string;
  branchName?: string;
  repoRootPath?: string;
  signal?: AbortSignal;
  recheck?: () => void | Promise<void>;
}): Promise<WorktreeTeardownCommandResult[]> {
  const teardownCwd = options.teardownCwd ?? options.worktreePath;
  if (getRealpathAwareRelativePath(options.worktreePath, teardownCwd) === null) {
    throw new Error(`Worktree teardown cwd is outside the worktree: ${teardownCwd}`);
  }
  const teardownCommands = getWorktreeTeardownCommands(teardownCwd);
  if (teardownCommands.length === 0) {
    return [];
  }

  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  await options.recheck?.();
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));
  await options.recheck?.();
  const worktreePort = readPaseoWorktreeRuntimePort(options.worktreePath);

  const teardownEnv: NodeJS.ProcessEnv = createStringCommandShellEnv(
    createExternalProcessEnv(process.env, {
      // Source checkout path is the original git repo root (shared across worktrees), not the
      // worktree itself. This allows lifecycle scripts to copy or clean resources using paths
      // from the source checkout.
      PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
      // Backward-compatible alias.
      PASEO_ROOT_PATH: repoRootPath,
      PASEO_WORKTREE_PATH: options.worktreePath,
      PASEO_BRANCH_NAME: branchName,
      ...(worktreePort !== null ? { PASEO_WORKTREE_PORT: String(worktreePort) } : {}),
    }),
  );

  const results: WorktreeTeardownCommandResult[] = [];
  const maxOutputBytes = getWorktreeSetupCommandOutputLimit(teardownCommands.length);
  for (const [index, cmd] of teardownCommands.entries()) {
    await options.recheck?.();
    const result = await execSetupCommandStreamed({
      command: cmd,
      cwd: teardownCwd,
      env: teardownEnv,
      index: index + 1,
      total: teardownCommands.length,
      maxOutputBytes,
      signal: options.signal,
    });
    await options.recheck?.();
    results.push(result);

    if (result.exitCode !== 0) {
      throw new WorktreeTeardownError(
        `Worktree teardown command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

export async function seedPaseoConfigFile(options: {
  sourceCwd: string;
  targetCwd: string;
}): Promise<void> {
  const sourceConfigPath = join(options.sourceCwd, "paseo.json");
  const targetConfigPath = join(options.targetCwd, "paseo.json");
  try {
    await stat(targetConfigPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copyFile(sourceConfigPath, targetConfigPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/**
 * Get the git common directory (shared across worktrees) for a given cwd.
 * This is where refs, objects, etc. are stored.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const commonDir = resolveGitRevParsePath(cwd, stdout);
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  return commonDir;
}

const WORKTREE_PROJECT_HASH_LENGTH = 8;

function deriveShortAlphanumericHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_PROJECT_HASH_LENGTH);
}

export async function deriveWorktreeProjectHash(cwd: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(cwd);
    const normalizedCommonDir = normalizePathForOwnership(commonDir);
    const repoRoot =
      basename(normalizedCommonDir) === ".git" ? dirname(normalizedCommonDir) : normalizedCommonDir;
    return deriveShortAlphanumericHash(repoRoot);
  } catch {
    return deriveShortAlphanumericHash(normalizePathForOwnership(cwd));
  }
}

export function resolvePaseoWorktreesBaseRoot(options?: WorktreeRootOptions): string {
  if (options?.worktreesRoot) {
    const expandedRoot = expandTilde(options.worktreesRoot);
    if (isAbsolute(expandedRoot)) {
      return resolve(expandedRoot);
    }
    const home = options.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
    return resolve(home, expandedRoot);
  }

  const home = options?.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
  return join(home, "worktrees");
}

export async function getPaseoWorktreesRoot(
  cwd: string,
  paseoHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const baseRoot = resolvePaseoWorktreesBaseRoot({ paseoHome, worktreesRoot });
  const projectHash = await deriveWorktreeProjectHash(cwd);
  return join(baseRoot, projectHash);
}

export async function computeWorktreePath(
  cwd: string,
  slug: string,
  paseoHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const projectWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  return join(projectWorktreesRoot, slug);
}

export function mapWorkspaceCwdToWorktree(input: {
  sourceWorktreePath: string;
  workspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(
    input.sourceWorktreePath,
    input.workspaceCwd,
  );
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${input.workspaceCwd}`);
  }

  return mapWorkspaceRelativeCwdToWorktree({
    relativeWorkspaceCwd,
    targetWorktreePath: input.targetWorktreePath,
  });
}

export function mapWorkspaceRelativeCwdToWorktree(input: {
  relativeWorkspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const mappedCwd = resolve(input.targetWorktreePath, input.relativeWorkspaceCwd);
  if (!isPathInsideRoot(input.targetWorktreePath, mappedCwd)) {
    throw new Error(`Workspace cwd escapes its target worktree: ${input.relativeWorkspaceCwd}`);
  }
  return mappedCwd;
}

function normalizePathForOwnership(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return resolve(input);
  }
}

function normalizePlannedPathForOwnership(input: string): string {
  const resolvedInput = resolve(input);
  const missingSegments: string[] = [];
  let existingAncestor = resolvedInput;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return join(normalizePathForOwnership(existingAncestor), ...missingSegments);
}

function resolveRepoRootFromGitCommonDir(commonDir: string): string {
  const normalizedCommonDir = normalizePathForOwnership(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

export async function isPaseoOwnedWorktreeCwd(
  cwd: string,
  options?: PaseoWorktreeOwnershipOptions,
): Promise<PaseoWorktreeOwnership> {
  const resolvedCwd = normalizePathForOwnership(cwd);

  // repoRoot is best-effort: git may be unreachable from the worktree (e.g. a
  // previous archive attempt removed the admin dir before the working tree
  // could be fully cleaned up). We still want to allow archiving in that case.
  let repoRoot: string | undefined;
  if (options?.knownGitCommonDir) {
    repoRoot = resolveRepoRootFromGitCommonDir(options.knownGitCommonDir);
  } else if (options?.knownGitCommonDir === undefined) {
    try {
      const gitCommonDir = await getGitCommonDir(cwd);
      repoRoot = resolveRepoRootFromGitCommonDir(gitCommonDir);
    } catch {
      // ignore
    }
  }

  const worktreesBaseRoot = resolvePaseoWorktreesBaseRoot(options);
  const relativePath = getRealpathAwareRelativePath(worktreesBaseRoot, resolvedCwd);

  // Ownership is defined by the path living under <worktrees-root>/<hash>/<slug>[/...].
  // The <hash>/<slug> prefix is Paseo-private — nothing else writes there — so the
  // path shape alone is sufficient proof of ownership, even when git has already
  // forgotten about the worktree.
  if (relativePath === null) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const parts = relativePath.split(sep).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const worktreesRoot = join(worktreesBaseRoot, parts[0]);
  return {
    allowed: true,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    worktreeRoot: worktreesRoot,
    worktreePath: join(worktreesRoot, parts[1]),
  };
}

type ParsedPaseoWorktreeInfo = Omit<PaseoWorktreeInfo, "createdAt">;

function parseWorktreeList(output: string): ParsedPaseoWorktreeInfo[] {
  const entries: ParsedPaseoWorktreeInfo[] = [];
  let current: ParsedPaseoWorktreeInfo | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.trim().length === 0) {
      if (current.path) {
        entries.push(current);
      }
      current = null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

function resolveWorktreeCreatedAtIso(worktreePath: string): string {
  try {
    const stats = statSync(worktreePath);
    const birthtimeMs = stats.birthtimeMs;
    const createdAtMs =
      Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : stats.ctimeMs;
    return new Date(createdAtMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export async function listPaseoWorktrees({
  cwd,
  paseoHome,
  worktreesRoot,
}: {
  cwd: string;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<PaseoWorktreeInfo[]> {
  const projectWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });

  return parseWorktreeList(stdout)
    .map((entry) => Object.assign({}, entry, { path: normalizePathForOwnership(entry.path) }))
    .filter((entry) => getRealpathAwareRelativePath(projectWorktreesRoot, entry.path) !== null)
    .map((entry) =>
      Object.assign({}, entry, { createdAt: resolveWorktreeCreatedAtIso(entry.path) }),
    );
}

export async function resolveExistingWorktreeForSlug({
  slug,
  repoRoot,
  paseoHome,
  worktreesRoot,
}: ResolveExistingWorktreeForSlugOptions): Promise<WorktreeConfig | null> {
  const worktrees = await listPaseoWorktrees({
    cwd: repoRoot,
    paseoHome,
    worktreesRoot,
  });
  const slugSuffix = `${sep}${slug}`;
  const existingWorktree = worktrees.find((worktree) => worktree.path.endsWith(slugSuffix));
  if (!existingWorktree) {
    return null;
  }

  const { stdout } = await runGitCommand(["branch", "--show-current"], {
    cwd: existingWorktree.path,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const branchName = stdout.trim();
  if (!branchName) {
    throw new Error(`Unable to resolve branch for existing worktree: ${existingWorktree.path}`);
  }

  return {
    branchName,
    worktreePath: existingWorktree.path,
  };
}

export interface DeletePaseoWorktreeOptions {
  cwd: string | null;
  worktreePath?: string;
  teardownCwds?: string[];
  worktreeSlug?: string;
  worktreesRoot?: string;
  paseoHome?: string;
  worktreesBaseRoot?: string;
  expectedWorktreeIncarnationId?: string | null;
  expectedQuarantineMarker?: string | null;
  onCleanupDirectoryPinned?: (quarantinePath: string) => void | Promise<void>;
  onCleanupDirectoryCompleted?: (quarantinePath: string) => void | Promise<void>;
  cleanupFaultPoint?: WorktreeCleanupFaultPoint;
  cleanupFindExecutable?: string;
  cleanupHelperTimeoutMs?: number;
  signal?: AbortSignal;
  recheck?: () => void | Promise<void>;
}

export class WorktreeCleanupRelocatedError extends Error {
  constructor(
    readonly remainingPath: string,
    readonly worktreeIncarnationId: string,
    cause: unknown,
    readonly quarantineMarker?: string,
  ) {
    super(`Worktree cleanup remains at ${remainingPath}`, { cause });
    this.name = "WorktreeCleanupRelocatedError";
  }
}

class WorktreeCleanupAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeCleanupAuthorityError";
  }
}

class WorktreeCleanupFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeCleanupFaultError";
  }
}

class WorktreeCleanupHelperTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Pinned worktree cleanup timed out after ${timeoutMs}ms`);
    this.name = "WorktreeCleanupHelperTimeoutError";
  }
}

function throwIfWorktreeDeletionCanceled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Worktree deletion canceled");
  error.name = "AbortError";
  throw error;
}

async function waitForWorktreeDeletionRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfWorktreeDeletionCanceled(signal);
  if (delayMs === 0) return;

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error("Worktree deletion canceled"), {
          name: "AbortError",
        }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function resolvePaseoWorktreeDeleteTarget(options: {
  cwd: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  worktreesRoot?: string;
  paseoHome?: string;
  worktreesBaseRoot?: string;
  recheck?: () => void | Promise<void>;
}): Promise<string> {
  let resolvedWorktreesRoot: string;
  if (options.worktreesRoot) {
    resolvedWorktreesRoot = options.worktreesRoot;
  } else if (options.cwd) {
    resolvedWorktreesRoot = await getPaseoWorktreesRoot(
      options.cwd,
      options.paseoHome,
      options.worktreesBaseRoot,
    );
    await options.recheck?.();
  } else {
    throw new Error("cwd or worktreesRoot is required to delete a Paseo worktree");
  }

  const requestedPath = options.worktreePath ?? join(resolvedWorktreesRoot, options.worktreeSlug!);
  const requestedReceipt = isPaseoWorktreeCleanupReceiptPath(requestedPath);
  const resolvedRequested = normalizePathForOwnership(requestedPath);
  const ownership = await isPaseoOwnedWorktreeCwd(requestedPath, {
    paseoHome: options.paseoHome,
    worktreesRoot: options.worktreesBaseRoot,
  });
  await options.recheck?.();
  const resolvedWorktree =
    !requestedReceipt && ownership.allowed && ownership.worktreePath
      ? ownership.worktreePath
      : resolvedRequested;
  const relativeWorktreePath = getRealpathAwareRelativePath(
    resolvedWorktreesRoot,
    resolvedWorktree,
  );
  if (relativeWorktreePath === null || relativeWorktreePath === "") {
    throw new Error("Refusing to delete non-Paseo worktree");
  }
  return resolvedWorktree;
}

export async function deletePaseoWorktree({
  cwd,
  worktreePath,
  teardownCwds,
  worktreeSlug,
  worktreesRoot,
  paseoHome,
  worktreesBaseRoot,
  expectedWorktreeIncarnationId,
  expectedQuarantineMarker,
  onCleanupDirectoryPinned,
  onCleanupDirectoryCompleted,
  cleanupFaultPoint,
  cleanupFindExecutable,
  cleanupHelperTimeoutMs,
  signal,
  recheck,
}: DeletePaseoWorktreeOptions): Promise<void> {
  throwIfWorktreeDeletionCanceled(signal);
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  const resolvedWorktree = await resolvePaseoWorktreeDeleteTarget({
    cwd,
    worktreePath,
    worktreeSlug,
    worktreesRoot,
    paseoHome,
    worktreesBaseRoot,
    recheck,
  });

  await recheck?.();
  const {
    initialIdentity,
    requestedRecovery,
    existingQuarantine,
    worktreeIncarnationId,
    quarantineMarker,
  } = await resolveWorktreeCleanupTarget(
    resolvedWorktree,
    expectedWorktreeIncarnationId,
    expectedQuarantineMarker,
  );

  if (!existingQuarantine && !requestedRecovery && initialIdentity !== null) {
    for (const teardownCwd of teardownCwds ?? [resolvedWorktree]) {
      await runWorktreeTeardownCommands({
        worktreePath: resolvedWorktree,
        teardownCwd,
        signal,
        recheck,
      });
    }
  }

  throwIfWorktreeDeletionCanceled(signal);
  await recheck?.();
  const quarantined =
    existingQuarantine ??
    (await quarantineDirectory({
      directoryPath: resolvedWorktree,
      expectedIdentity: initialIdentity,
      worktreeIncarnationId,
      quarantineMarker,
      requestedRecovery,
      recheck,
    }));
  await removeQuarantinedWorktree({
    cwd,
    quarantined,
    onCleanupDirectoryPinned,
    onCleanupDirectoryCompleted,
    cleanupFaultPoint,
    cleanupFindExecutable,
    cleanupHelperTimeoutMs,
    signal,
    recheck,
  });
}

interface WorktreeCleanupTarget {
  initialIdentity: string | null;
  requestedRecovery: boolean;
  existingQuarantine: QuarantinedDirectory | null;
  worktreeIncarnationId: string | null;
  quarantineMarker: string;
}

async function resolveWorktreeCleanupTarget(
  resolvedWorktree: string,
  expectedWorktreeIncarnationId: string | null | undefined,
  expectedQuarantineMarker: string | null | undefined,
): Promise<WorktreeCleanupTarget> {
  const initialIdentity = await readDirectoryIdentity(resolvedWorktree);
  const requestedRecovery = Boolean(
    expectedWorktreeIncarnationId &&
    (isPaseoWorktreeCleanupQuarantinePath(resolvedWorktree, expectedWorktreeIncarnationId) ||
      isPaseoWorktreeCleanupReceiptPath(resolvedWorktree)),
  );
  const currentIncarnationId =
    !requestedRecovery && initialIdentity !== null
      ? readPaseoWorktreeIncarnationId(resolvedWorktree)
      : null;
  const quarantineCandidate = await resolveCleanupQuarantineCandidate({
    resolvedWorktree,
    initialIdentity,
    requestedRecovery,
    expectedWorktreeIncarnationId,
    expectedQuarantineMarker,
  });
  const existingQuarantine =
    quarantineCandidate &&
    (requestedRecovery || currentIncarnationId !== expectedWorktreeIncarnationId)
      ? quarantineCandidate
      : null;
  const worktreeIncarnationId = existingQuarantine
    ? existingQuarantine.worktreeIncarnationId
    : await resolveCleanupIncarnationId(
        resolvedWorktree,
        initialIdentity,
        expectedWorktreeIncarnationId,
      );
  const quarantineMarker =
    existingQuarantine?.quarantineMarker ?? expectedQuarantineMarker ?? randomUUID();
  if (
    !existingQuarantine &&
    initialIdentity !== null &&
    worktreeIncarnationId !== null &&
    expectedWorktreeIncarnationId !== undefined &&
    currentIncarnationId !== worktreeIncarnationId
  ) {
    throw new Error(`Cleanup worktree incarnation changed for ${resolvedWorktree}`);
  }
  return {
    initialIdentity,
    requestedRecovery,
    existingQuarantine,
    worktreeIncarnationId,
    quarantineMarker,
  };
}

async function resolveCleanupQuarantineCandidate(input: {
  resolvedWorktree: string;
  initialIdentity: string | null;
  requestedRecovery: boolean;
  expectedWorktreeIncarnationId: string | null | undefined;
  expectedQuarantineMarker: string | null | undefined;
}): Promise<QuarantinedDirectory | null> {
  if (!input.expectedWorktreeIncarnationId) return null;
  const existing = await readExistingCleanupQuarantine(
    input.resolvedWorktree,
    input.expectedWorktreeIncarnationId,
    input.expectedQuarantineMarker,
  );
  if (input.requestedRecovery && input.initialIdentity !== null && existing === null) {
    throw new Error(`Cleanup quarantine marker changed for ${input.resolvedWorktree}`);
  }
  return existing;
}

async function resolveCleanupIncarnationId(
  worktreePath: string,
  currentIdentity: string | null,
  expectedWorktreeIncarnationId: string | null | undefined,
): Promise<string | null> {
  if (expectedWorktreeIncarnationId !== undefined) {
    if (expectedWorktreeIncarnationId === null && currentIdentity !== null) {
      throw new Error(`Cleanup worktree incarnation is missing for ${worktreePath}`);
    }
    return expectedWorktreeIncarnationId;
  }
  if (currentIdentity === null) return null;
  return ensurePaseoWorktreeIncarnationId(worktreePath);
}

async function removeQuarantinedWorktree(input: {
  cwd: string | null;
  quarantined: QuarantinedDirectory | null;
  onCleanupDirectoryPinned?: (quarantinePath: string) => void | Promise<void>;
  onCleanupDirectoryCompleted?: (quarantinePath: string) => void | Promise<void>;
  cleanupFaultPoint?: WorktreeCleanupFaultPoint;
  cleanupFindExecutable?: string;
  cleanupHelperTimeoutMs?: number;
  signal?: AbortSignal;
  recheck?: () => void | Promise<void>;
}): Promise<void> {
  try {
    throwIfWorktreeDeletionCanceled(input.signal);
    if (input.cwd) {
      await input.recheck?.();
      try {
        await runGitCommand(["worktree", "prune", "--expire=now"], {
          cwd: input.cwd,
          timeout: 30_000,
          signal: input.signal,
        });
        throwIfWorktreeDeletionCanceled(input.signal);
      } catch {
        throwIfWorktreeDeletionCanceled(input.signal);
        // The missing worktree admin entry is harmless; Git also prunes it lazily.
      }
      await input.recheck?.();
    }

    if (input.quarantined) {
      await input.recheck?.();
      await removeDirectoryWithRetries({
        path: input.quarantined.path,
        receiptPath: input.quarantined.receiptPath,
        expectedDirectoryIdentity: input.quarantined.identity,
        quarantineMarker: input.quarantined.quarantineMarker,
        onDirectoryPinned: input.onCleanupDirectoryPinned,
        onDirectoryCompleted: input.onCleanupDirectoryCompleted,
        faultPoint: input.cleanupFaultPoint,
        findExecutable: input.cleanupFindExecutable,
        helperTimeoutMs: input.cleanupHelperTimeoutMs,
        signal: input.signal,
        recheck: input.recheck,
      });
    }
  } catch (error) {
    if (input.quarantined) {
      let remainingIdentity: string | null;
      try {
        remainingIdentity = await readDirectoryIdentity(input.quarantined.path);
      } catch {
        throw error;
      }
      const receiptIdentity = await readDirectoryIdentity(input.quarantined.receiptPath);
      if (
        remainingIdentity === input.quarantined.identity ||
        receiptIdentity === input.quarantined.identity
      ) {
        const remainingPath =
          receiptIdentity === input.quarantined.identity
            ? input.quarantined.receiptPath
            : input.quarantined.path;
        throw new WorktreeCleanupRelocatedError(
          remainingPath,
          input.quarantined.worktreeIncarnationId,
          error,
          input.quarantined.quarantineMarker,
        );
      }
    }
    throw error;
  }
}

interface QuarantinedDirectory {
  path: string;
  receiptPath: string;
  identity: string;
  worktreeIncarnationId: string;
  quarantineMarker: string;
}

async function quarantineDirectory(input: {
  directoryPath: string;
  expectedIdentity: string | null;
  worktreeIncarnationId: string | null;
  quarantineMarker: string;
  requestedRecovery: boolean;
  recheck?: () => void | Promise<void>;
}): Promise<QuarantinedDirectory | null> {
  const identity = await readDirectoryIdentity(input.directoryPath);
  await input.recheck?.();
  if (identity === null) {
    if (input.expectedIdentity === null) return null;
    if (input.worktreeIncarnationId === null) return null;
    if (input.requestedRecovery) return null;
    return readExistingCleanupQuarantine(
      input.directoryPath,
      input.worktreeIncarnationId,
      input.quarantineMarker,
    );
  }
  if (identity !== input.expectedIdentity) {
    throw new Error(`Cleanup path identity changed for ${input.directoryPath}`);
  }
  if (input.worktreeIncarnationId === null) {
    throw new Error(`Cleanup worktree incarnation is missing for ${input.directoryPath}`);
  }
  const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
    input.directoryPath,
    input.worktreeIncarnationId,
  );
  if ((await readDirectoryIdentity(quarantinePath)) !== null) {
    throw new Error(`Cleanup quarantine path already exists: ${quarantinePath}`);
  }
  await input.recheck?.();
  await ensurePaseoWorktreeCleanupMarker(input.directoryPath, input.quarantineMarker);
  const identityBeforeRename = await readDirectoryIdentity(input.directoryPath);
  await input.recheck?.();
  if (identityBeforeRename !== identity) {
    throw new Error(`Cleanup path identity changed for ${input.directoryPath}`);
  }
  await rename(input.directoryPath, quarantinePath);
  const quarantinedIdentity = await readDirectoryIdentity(quarantinePath);
  await input.recheck?.();
  if (quarantinedIdentity !== identity) {
    throw new WorktreeCleanupRelocatedError(
      quarantinePath,
      input.worktreeIncarnationId,
      new Error(`Cleanup path identity changed for ${input.directoryPath}`),
      input.quarantineMarker,
    );
  }
  return {
    path: quarantinePath,
    receiptPath: getPaseoWorktreeCleanupReceiptPath(
      quarantinePath,
      input.worktreeIncarnationId,
      input.quarantineMarker,
    ),
    identity,
    worktreeIncarnationId: input.worktreeIncarnationId,
    quarantineMarker: input.quarantineMarker,
  };
}

export function getPaseoWorktreeCleanupQuarantinePath(
  directoryPath: string,
  worktreeIncarnationId: string,
): string {
  return join(
    dirname(directoryPath),
    `.paseo-cleanup-${basename(directoryPath)}-${worktreeIncarnationId}`,
  );
}

export function isPaseoWorktreeCleanupQuarantinePath(
  directoryPath: string,
  worktreeIncarnationId: string,
): boolean {
  const name = basename(directoryPath);
  return name.startsWith(".paseo-cleanup-") && name.endsWith(`-${worktreeIncarnationId}`);
}

export function getPaseoWorktreeCleanupRecoveryRootPath(directoryPath: string): string {
  if (isPaseoWorktreeCleanupReceiptPath(directoryPath)) return dirname(directoryPath);
  return join(dirname(directoryPath), WORKTREE_CLEANUP_RECOVERY_ROOT_NAME);
}

export function getPaseoWorktreeCleanupReceiptPath(
  quarantinePath: string,
  worktreeIncarnationId: string,
  quarantineMarker: string,
): string {
  if (isPaseoWorktreeCleanupReceiptPath(quarantinePath)) return resolve(quarantinePath);
  if (!UUID_PATTERN.test(quarantineMarker)) {
    throw new Error("Invalid cleanup quarantine marker");
  }
  const authorityHash = createHash("sha256")
    .update(resolve(quarantinePath))
    .update("\0")
    .update(worktreeIncarnationId)
    .update("\0")
    .update(quarantineMarker)
    .digest("hex");
  return join(
    getPaseoWorktreeCleanupRecoveryRootPath(quarantinePath),
    `${WORKTREE_CLEANUP_RECEIPT_PREFIX}${authorityHash}`,
  );
}

export function isPaseoWorktreeCleanupReceiptPath(directoryPath: string): boolean {
  return (
    basename(dirname(directoryPath)) === WORKTREE_CLEANUP_RECOVERY_ROOT_NAME &&
    new RegExp(`^${WORKTREE_CLEANUP_RECEIPT_PREFIX}[0-9a-f]{64}$`).test(basename(directoryPath))
  );
}

function assertTrustedCleanupRecoveryRoot(
  quarantineOrReceiptPath: string,
  create: boolean,
): string {
  const recoveryRoot = getPaseoWorktreeCleanupRecoveryRootPath(quarantineOrReceiptPath);
  const recoveryParent = dirname(recoveryRoot);
  const expectedRootPath = resolve(recoveryRoot);
  const parentStats = lstatSync(recoveryParent);
  if (!parentStats.isDirectory()) {
    throw new WorktreeCleanupAuthorityError("Cleanup recovery parent identity changed");
  }
  if (create) {
    try {
      mkdirSync(expectedRootPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const rootStats = lstatSync(expectedRootPath);
  const expectedRootRealpath = join(realpathSync(recoveryParent), basename(expectedRootPath));
  if (
    !rootStats.isDirectory() ||
    realpathSync(expectedRootPath) !== expectedRootRealpath ||
    rootStats.dev !== parentStats.dev
  ) {
    throw new WorktreeCleanupAuthorityError("Cleanup recovery root identity changed");
  }
  if (typeof process.getuid === "function" && rootStats.uid !== process.getuid()) {
    throw new WorktreeCleanupAuthorityError("Cleanup recovery root owner changed");
  }
  if ((rootStats.mode & 0o777) !== 0o700) {
    throw new WorktreeCleanupAuthorityError("Cleanup recovery root permissions changed");
  }
  if (process.platform === "linux") {
    let mountInfo: string;
    try {
      mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
    } catch (error) {
      throw new WorktreeCleanupAuthorityError(
        `Linux mount identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parseLinuxMountPoints(mountInfo).includes(expectedRootPath)) {
      throw new WorktreeCleanupAuthorityError("Cleanup recovery root is a Linux mount point");
    }
  }
  return `${rootStats.dev}:${rootStats.ino}`;
}

async function readExistingCleanupQuarantine(
  directoryPath: string,
  worktreeIncarnationId: string,
  quarantineMarker: string | null | undefined,
): Promise<QuarantinedDirectory | null> {
  const directReceipt = isPaseoWorktreeCleanupReceiptPath(directoryPath);
  let quarantinePath: string | null = null;
  if (!directReceipt) {
    quarantinePath = isPaseoWorktreeCleanupQuarantinePath(directoryPath, worktreeIncarnationId)
      ? directoryPath
      : getPaseoWorktreeCleanupQuarantinePath(directoryPath, worktreeIncarnationId);
  }
  let receiptPath: string | null = null;
  if (directReceipt) {
    receiptPath = directoryPath;
  } else if (quarantineMarker) {
    receiptPath = getPaseoWorktreeCleanupReceiptPath(
      quarantinePath!,
      worktreeIncarnationId,
      quarantineMarker,
    );
  }
  const [quarantineIdentity, receiptIdentity] = await Promise.all([
    quarantinePath ? readDirectoryIdentity(quarantinePath) : Promise.resolve(null),
    receiptPath ? readDirectoryIdentity(receiptPath) : Promise.resolve(null),
  ]);
  if (quarantineIdentity !== null && receiptIdentity !== null) {
    throw new Error("Cleanup quarantine and receipt both exist");
  }
  if (quarantineIdentity === null && receiptIdentity === null) return null;
  if (!quarantineMarker) {
    throw new Error(`Cleanup quarantine marker changed for ${quarantinePath ?? receiptPath}`);
  }
  if (quarantineIdentity !== null) {
    if ((await readPaseoWorktreeCleanupMarkerState(quarantinePath!, quarantineMarker)) === null) {
      throw new Error(`Cleanup quarantine marker changed for ${quarantinePath}`);
    }
    return {
      path: quarantinePath!,
      receiptPath: receiptPath!,
      identity: quarantineIdentity,
      worktreeIncarnationId,
      quarantineMarker,
    };
  }

  assertTrustedCleanupRecoveryRoot(receiptPath!, false);
  const markerState = await readPaseoWorktreeCleanupMarkerState(receiptPath!, quarantineMarker);
  const receiptEntries = await readdir(receiptPath!);
  if (markerState !== "completed" && !(markerState === null && receiptEntries.length === 0)) {
    throw new Error(`Cleanup receipt marker changed for ${receiptPath}`);
  }
  return {
    path: receiptPath!,
    receiptPath: receiptPath!,
    identity: receiptIdentity!,
    worktreeIncarnationId,
    quarantineMarker,
  };
}

export async function findPaseoWorktreeCleanupRecoveryPath(
  directoryPath: string,
  worktreeIncarnationId: string,
  quarantineMarker?: string | null,
): Promise<string | null> {
  return (
    (await readExistingCleanupQuarantine(directoryPath, worktreeIncarnationId, quarantineMarker))
      ?.path ?? null
  );
}

export async function hasPaseoWorktreeCleanupQuarantine(
  directoryPath: string,
  worktreeIncarnationId: string,
  quarantineMarker?: string | null,
): Promise<boolean> {
  try {
    return (
      (await findPaseoWorktreeCleanupRecoveryPath(
        directoryPath,
        worktreeIncarnationId,
        quarantineMarker,
      )) !== null
    );
  } catch {
    return false;
  }
}

export function getPaseoWorktreeCleanupMarkerPath(
  directoryPath: string,
  quarantineMarker: string,
): string {
  if (!UUID_PATTERN.test(quarantineMarker)) {
    throw new Error("Invalid cleanup quarantine marker");
  }
  return join(directoryPath, `${WORKTREE_CLEANUP_MARKER_PREFIX}${quarantineMarker}`);
}

export function getPaseoWorktreeCleanupCompletedMarkerPath(
  directoryPath: string,
  quarantineMarker: string,
): string {
  if (!UUID_PATTERN.test(quarantineMarker)) {
    throw new Error("Invalid cleanup quarantine marker");
  }
  return join(directoryPath, `${WORKTREE_CLEANUP_COMPLETED_MARKER_PREFIX}${quarantineMarker}`);
}

type WorktreeCleanupMarkerState = "active" | "completed";

async function readPaseoWorktreeCleanupMarkerState(
  directoryPath: string,
  quarantineMarker: string,
): Promise<WorktreeCleanupMarkerState | null> {
  const markerPaths = [
    getPaseoWorktreeCleanupMarkerPath(directoryPath, quarantineMarker),
    getPaseoWorktreeCleanupCompletedMarkerPath(directoryPath, quarantineMarker),
  ];
  const markerFiles = await Promise.all(
    markerPaths.map(async (markerPath) => {
      try {
        return (await lstat(markerPath)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  if (markerFiles[0] === markerFiles[1]) return null;
  return markerFiles[0] ? "active" : "completed";
}

async function hasPaseoWorktreeCleanupMarker(
  directoryPath: string,
  quarantineMarker: string,
): Promise<boolean> {
  return (await readPaseoWorktreeCleanupMarkerState(directoryPath, quarantineMarker)) !== null;
}

async function ensurePaseoWorktreeCleanupMarker(
  directoryPath: string,
  quarantineMarker: string,
): Promise<void> {
  const markerPath = getPaseoWorktreeCleanupMarkerPath(directoryPath, quarantineMarker);
  try {
    await writeFile(markerPath, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      (await hasPaseoWorktreeCleanupMarker(directoryPath, quarantineMarker))
    ) {
      return;
    }
    throw error;
  }
}

async function readDirectoryIdentity(directoryPath: string): Promise<string | null> {
  try {
    const stats = await lstat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Cleanup path is not a directory: ${directoryPath}`);
    }
    return `${stats.dev}:${stats.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function rollbackCreatedPaseoWorktree(
  options: DeletePaseoWorktreeOptions,
  cause: unknown,
): Promise<never> {
  let cleanupError: unknown;
  try {
    await deletePaseoWorktree(options);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    const failure = new Error(
      `${cause instanceof Error ? cause.message : "Worktree workflow failed"}; rollback also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      { cause },
    );
    Object.assign(failure, { cleanupError });
    throw failure;
  }
  throw cause;
}

async function removeDirectoryWithRetries(input: {
  path: string;
  receiptPath: string;
  expectedDirectoryIdentity: string;
  quarantineMarker: string;
  onDirectoryPinned?: (quarantinePath: string) => void | Promise<void>;
  onDirectoryCompleted?: (quarantinePath: string) => void | Promise<void>;
  faultPoint?: WorktreeCleanupFaultPoint;
  findExecutable?: string;
  helperTimeoutMs?: number;
  signal?: AbortSignal;
  recheck?: () => void | Promise<void>;
}): Promise<void> {
  throwIfWorktreeDeletionCanceled(input.signal);
  const delaysMs = [0, 100, 300, 700, 1500];
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    await waitForWorktreeDeletionRetry(delay, input.signal);
    await input.recheck?.();
    try {
      const cleanupPath = await findRemainingPinnedCleanupPath(input);
      await input.recheck?.();
      if (!cleanupPath) return;
      await removePinnedDirectory({
        path: cleanupPath,
        receiptPath: input.receiptPath,
        expectedDirectoryIdentity: input.expectedDirectoryIdentity,
        quarantineMarker: input.quarantineMarker,
        onDirectoryPinned: input.onDirectoryPinned,
        onDirectoryCompleted: input.onDirectoryCompleted,
        faultPoint: input.faultPoint,
        findExecutable: input.findExecutable,
        helperTimeoutMs: input.helperTimeoutMs,
        signal: input.signal,
        recheck: input.recheck,
      });
      throwIfWorktreeDeletionCanceled(input.signal);
      await input.recheck?.();
      const remainingPath = await findRemainingPinnedCleanupPath(input);
      await input.recheck?.();
      if (!remainingPath) return;
      lastError = new Error(`Cleanup receipt is incomplete: ${remainingPath}`);
    } catch (error) {
      throwIfWorktreeDeletionCanceled(input.signal);
      if (
        error instanceof WorktreeCleanupAuthorityError ||
        error instanceof WorktreeCleanupFaultError ||
        error instanceof WorktreeCleanupHelperTimeoutError
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to complete worktree cleanup: ${input.path}`);
}

async function findRemainingPinnedCleanupPath(input: {
  path: string;
  receiptPath: string;
  expectedDirectoryIdentity: string;
}): Promise<string | null> {
  const paths = input.path === input.receiptPath ? [input.path] : [input.path, input.receiptPath];
  const identities = await Promise.all(paths.map((path) => readDirectoryIdentity(path)));
  const remainingPaths: string[] = [];
  for (const [index, identity] of identities.entries()) {
    if (identity === null) continue;
    const path = paths[index]!;
    if (identity !== input.expectedDirectoryIdentity) {
      throw new WorktreeCleanupAuthorityError(`Cleanup path identity changed for ${path}`);
    }
    remainingPaths.push(path);
  }
  if (remainingPaths.length > 1) {
    throw new WorktreeCleanupAuthorityError("Cleanup quarantine and receipt both exist");
  }
  return remainingPaths[0] ?? null;
}

async function resolvePosixFindExecutable(): Promise<string> {
  if (existsSync("/usr/bin/find")) return "/usr/bin/find";
  if (existsSync("/bin/find")) return "/bin/find";
  posixFindExecutablePromise ??= findExecutableOnPath("find").then((executable) => {
    if (!executable) throw new Error("Filesystem-bounded POSIX cleanup helper is unavailable");
    return executable;
  });
  return posixFindExecutablePromise;
}

interface RemovePinnedDirectoryInput {
  path: string;
  receiptPath: string;
  expectedDirectoryIdentity: string;
  quarantineMarker: string;
  onDirectoryPinned?: (quarantinePath: string) => void | Promise<void>;
  onDirectoryCompleted?: (quarantinePath: string) => void | Promise<void>;
  faultPoint?: WorktreeCleanupFaultPoint;
  findExecutable?: string;
  helperTimeoutMs?: number;
  signal?: AbortSignal;
  recheck?: () => void | Promise<void>;
}

type CleanupHelperStopReason = "abort" | "authorization" | "timeout";

interface CleanupHelperProtocolState {
  ready: boolean;
  completed: boolean;
  completedPath: string | null;
  authorizationError: unknown;
  authorizationTask: Promise<void>;
}

interface CleanupHelperProtocolContext {
  line: string;
  input: RemovePinnedDirectoryInput;
  state: CleanupHelperProtocolState;
  startsInReceipt: boolean;
  helperReceiptPath: string;
  recoveryRootIdentity: string;
  armTimeout: (timeoutMs: number) => void;
  requestStop: (reason: CleanupHelperStopReason) => void;
  sendCommand: (command: string) => void;
}

function authorizeCleanupHelperOperation(
  context: CleanupHelperProtocolContext,
  operation: () => Promise<void>,
): void {
  context.state.authorizationTask = context.state.authorizationTask
    .then(operation)
    .catch((error: unknown) => {
      context.state.authorizationError = error;
      context.requestStop("authorization");
    });
}

function handleCleanupHelperProtocolLine(context: CleanupHelperProtocolContext): void {
  const {
    line,
    input,
    state,
    startsInReceipt,
    helperReceiptPath,
    recoveryRootIdentity,
    armTimeout,
    sendCommand,
  } = context;
  if (line === POSIX_CLEANUP_READY) {
    authorizeCleanupHelperOperation(context, async () => {
      if (state.ready) throw new WorktreeCleanupAuthorityError("Duplicate cleanup ready message");
      state.ready = true;
      await assertPinnedCleanupDirectory({ ...input, requireCompleted: false });
      await input.onDirectoryPinned?.(input.path);
      await input.recheck?.();
      armTimeout(input.helperTimeoutMs ?? DEFAULT_CLEANUP_HELPER_TIMEOUT_MS);
      sendCommand("REMOVE\n");
    });
    return;
  }
  if (line === POSIX_CLEANUP_COMPLETED) {
    authorizeCleanupHelperOperation(context, async () => {
      if (!state.ready || state.completed) {
        throw new WorktreeCleanupAuthorityError("Unexpected cleanup completed message");
      }
      state.completed = true;
      await assertPinnedCleanupDirectory({ ...input, requireCompleted: true });
      await input.onDirectoryCompleted?.(input.path);
      await assertPinnedCleanupDirectory({ ...input, requireCompleted: true });
      if (assertTrustedCleanupRecoveryRoot(input.receiptPath, false) !== recoveryRootIdentity) {
        throw new WorktreeCleanupAuthorityError("Cleanup recovery root identity changed");
      }
      if (!startsInReceipt && (await readDirectoryIdentity(input.receiptPath)) !== null) {
        throw new WorktreeCleanupAuthorityError(
          `Cleanup receipt already exists: ${input.receiptPath}`,
        );
      }
      await input.recheck?.();
      sendCommand("RELOCATE\n");
    });
    return;
  }
  if (line.startsWith(POSIX_CLEANUP_DONE)) {
    authorizeCleanupHelperOperation(context, async () => {
      if (!state.completed || state.completedPath) {
        throw new WorktreeCleanupAuthorityError("Unexpected cleanup done message");
      }
      const parsedPath = JSON.parse(line.slice(POSIX_CLEANUP_DONE.length)) as unknown;
      if (parsedPath !== helperReceiptPath) {
        throw new WorktreeCleanupAuthorityError("Cleanup helper reported an invalid receipt");
      }
      state.completedPath = parsedPath;
    });
    return;
  }
  authorizeCleanupHelperOperation(context, async () => {
    throw new WorktreeCleanupAuthorityError("Cleanup helper emitted invalid output");
  });
}

interface PreparedPinnedCleanupHelper {
  startsInReceipt: boolean;
  helperTimeoutMs: number;
  activeMarkerName: string;
  completedMarkerName: string;
  trustedParent: string;
  recoveryRoot: string;
  recoveryRootIdentity: string;
  helperReceiptPath: string;
  traversalKind: WorktreeCleanupTraversalContract["kind"];
  findExecutable: string;
  findArguments: string[];
}

async function preparePinnedCleanupHelper(
  input: RemovePinnedDirectoryInput,
): Promise<PreparedPinnedCleanupHelper> {
  throwIfWorktreeDeletionCanceled(input.signal);
  await input.recheck?.();
  const startsInReceipt = input.path === input.receiptPath;
  const helperTimeoutMs = input.helperTimeoutMs ?? DEFAULT_CLEANUP_HELPER_TIMEOUT_MS;
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs <= 0) {
    throw new Error("Cleanup helper timeout must be a positive finite number");
  }
  const activeMarkerName = basename(
    getPaseoWorktreeCleanupMarkerPath(input.path, input.quarantineMarker),
  );
  const completedMarkerName = basename(
    getPaseoWorktreeCleanupCompletedMarkerPath(input.path, input.quarantineMarker),
  );
  const pinnedPath = realpathSync(input.path);
  const trustedParent = dirname(pinnedPath);
  const recoveryRootPath = getPaseoWorktreeCleanupRecoveryRootPath(input.receiptPath);
  const recoveryRootIdentity = assertTrustedCleanupRecoveryRoot(
    input.receiptPath,
    !startsInReceipt,
  );
  const recoveryRoot = realpathSync(recoveryRootPath);
  const helperReceiptPath = join(recoveryRoot, basename(input.receiptPath));
  if (!startsInReceipt && (await readDirectoryIdentity(input.receiptPath)) !== null) {
    throw new WorktreeCleanupAuthorityError(`Cleanup receipt already exists: ${input.receiptPath}`);
  }
  const traversalContract = getWorktreeCleanupTraversalContract(process.platform);
  let findExecutable = "";
  let findArguments: string[] = [];
  if (!startsInReceipt && traversalContract.kind === "posix-find") {
    findExecutable = input.findExecutable ?? (await resolvePosixFindExecutable());
    findArguments = getWorktreeCleanupFindArguments(
      process.platform,
      activeMarkerName,
      completedMarkerName,
    );
  }
  return {
    startsInReceipt,
    helperTimeoutMs,
    activeMarkerName,
    completedMarkerName,
    trustedParent,
    recoveryRoot,
    recoveryRootIdentity,
    helperReceiptPath,
    traversalKind: traversalContract.kind,
    findExecutable,
    findArguments,
  };
}

async function removePinnedDirectory(input: RemovePinnedDirectoryInput): Promise<void> {
  const {
    startsInReceipt,
    helperTimeoutMs,
    activeMarkerName,
    completedMarkerName,
    trustedParent,
    recoveryRoot,
    recoveryRootIdentity,
    helperReceiptPath,
    traversalKind,
    findExecutable,
    findArguments,
  } = await preparePinnedCleanupHelper(input);
  const child = spawn(
    process.execPath,
    [
      "-e",
      POSIX_PINNED_CLEANUP_SCRIPT,
      input.expectedDirectoryIdentity,
      activeMarkerName,
      completedMarkerName,
      trustedParent,
      recoveryRoot,
      recoveryRootIdentity,
      helperReceiptPath,
      traversalKind,
      findExecutable,
      JSON.stringify(findArguments),
      input.faultPoint ?? "",
    ],
    {
      cwd: input.path,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin.on("error", () => undefined);

  let stdoutBuffer = "";
  let stderr = "";
  let launchError: Error | null = null;
  const protocolState: CleanupHelperProtocolState = {
    ready: false,
    completed: false,
    completedPath: null,
    authorizationError: null,
    authorizationTask: Promise.resolve(),
  };
  let requestStop: (reason: CleanupHelperStopReason) => void = () => undefined;
  const stopRequested = new Promise<CleanupHelperStopReason>((resolvePromise) => {
    let requested = false;
    requestStop = (reason) => {
      if (requested) return;
      requested = true;
      resolvePromise(reason);
    };
  });
  let timeout: NodeJS.Timeout | null = null;
  const armTimeout = (timeoutMs: number) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => requestStop("timeout"), timeoutMs);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleCleanupHelperProtocolLine({
        line,
        input,
        state: protocolState,
        startsInReceipt,
        helperReceiptPath,
        recoveryRootIdentity,
        armTimeout,
        requestStop,
        sendCommand: (command) => child.stdin.write(command),
      });
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    launchError = error;
  });

  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    },
  );
  armTimeout(Math.max(helperTimeoutMs, 5_000));
  const onAbort = () => requestStop("abort");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) requestStop("abort");

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  let stopReason: CleanupHelperStopReason | null = null;
  try {
    const outcome = await Promise.race([
      close.then((result) => ({ kind: "exit" as const, result })),
      stopRequested.then((reason) => ({ kind: "stop" as const, reason })),
    ]);
    if (outcome.kind === "exit") {
      exit = outcome.result;
    } else {
      stopReason = outcome.reason;
      child.stdin.destroy();
      await terminateWithTreeKill(child, {
        gracefulSignal: "SIGKILL",
        gracefulTimeoutMs: 1_000,
        forceTimeoutMs: 1_000,
      });
      exit = await close;
    }
    await protocolState.authorizationTask;
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }

  if (stopReason === "abort") throwIfWorktreeDeletionCanceled(input.signal);
  if (protocolState.authorizationError) throw protocolState.authorizationError;
  if (stopReason === "timeout") throw new WorktreeCleanupHelperTimeoutError(helperTimeoutMs);
  if (launchError) throw launchError;
  if (
    exit.code !== 0 ||
    !protocolState.ready ||
    !protocolState.completed ||
    !protocolState.completedPath
  ) {
    throwPinnedCleanupProcessError(stderr, exit);
  }
  const remainingPath = await findRemainingPinnedCleanupPath(input);
  if (remainingPath) {
    throw new WorktreeCleanupAuthorityError(`Cleanup receipt remained at ${remainingPath}`);
  }
}

async function assertPinnedCleanupDirectory(input: {
  path: string;
  receiptPath: string;
  expectedDirectoryIdentity: string;
  quarantineMarker: string;
  requireCompleted: boolean;
}): Promise<void> {
  let identity: string | null;
  try {
    identity = await readDirectoryIdentity(input.path);
  } catch (error) {
    throw new WorktreeCleanupAuthorityError(
      error instanceof Error ? error.message : `Cleanup path identity changed for ${input.path}`,
    );
  }
  if (identity !== input.expectedDirectoryIdentity) {
    throw new WorktreeCleanupAuthorityError(`Cleanup path identity changed for ${input.path}`);
  }
  const markerState = await readPaseoWorktreeCleanupMarkerState(input.path, input.quarantineMarker);
  if (input.path === input.receiptPath) {
    const entries = await readdir(input.path);
    const completedMarkerName = basename(
      getPaseoWorktreeCleanupCompletedMarkerPath(input.path, input.quarantineMarker),
    );
    if (
      !(
        (markerState === "completed" &&
          entries.length === 1 &&
          entries[0] === completedMarkerName) ||
        (markerState === null && entries.length === 0)
      )
    ) {
      throw new WorktreeCleanupAuthorityError(`Cleanup receipt marker changed for ${input.path}`);
    }
    return;
  }
  if (input.requireCompleted) {
    const entries = await readdir(input.path);
    const completedMarkerName = basename(
      getPaseoWorktreeCleanupCompletedMarkerPath(input.path, input.quarantineMarker),
    );
    if (markerState !== "completed" || entries.length !== 1 || entries[0] !== completedMarkerName) {
      throw new WorktreeCleanupAuthorityError(
        `Cleanup completion marker changed for ${input.path}`,
      );
    }
  } else if (markerState === null) {
    throw new WorktreeCleanupAuthorityError(`Cleanup quarantine marker changed for ${input.path}`);
  }
}

function throwPinnedCleanupProcessError(
  stderr: string,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): never {
  const detail = stderr.trim() || `helper exited with ${exit.signal ?? exit.code ?? "no status"}`;
  if (detail.startsWith("AUTHORITY:")) {
    throw new WorktreeCleanupAuthorityError(detail.slice("AUTHORITY:".length));
  }
  if (detail.startsWith("BOUNDARY:")) {
    throw new WorktreeCleanupAuthorityError(detail.slice("BOUNDARY:".length));
  }
  if (detail.startsWith("FAULT:")) {
    throw new WorktreeCleanupFaultError(detail.slice("FAULT:".length));
  }
  throw new Error(`Pinned worktree cleanup failed: ${detail}`);
}

/**
 * Create a git worktree with proper naming conventions
 */
export const createWorktree = async ({
  cwd,
  source,
  worktreeSlug,
  runSetup,
  paseoHome,
  worktreesRoot,
  onWorktreePathPlanned,
  onWorktreePathResolved,
}: CreateWorktreeOptions): Promise<WorktreeConfig> => {
  if (Boolean(onWorktreePathPlanned) !== Boolean(onWorktreePathResolved)) {
    throw new Error("Worktree creation journaling requires both planning and identity callbacks");
  }
  const sourcePlan = await resolveWorktreeSourcePlan({ cwd, source, desiredSlug: worktreeSlug });
  let worktreePath = join(await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot), worktreeSlug);

  // Also handle worktree path collision. Journaled creation first persists the
  // exact candidate path and incarnation, then atomically claims the directory.
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  const worktreeIncarnationId = randomUUID();
  if (onWorktreePathPlanned && onWorktreePathResolved) {
    while (true) {
      const normalizedCandidatePath = normalizePlannedPathForOwnership(finalWorktreePath);
      if (existsSync(normalizedCandidatePath)) {
        finalWorktreePath = `${worktreePath}-${pathSuffix}`;
        pathSuffix++;
        continue;
      }
      await onWorktreePathPlanned(normalizedCandidatePath, {
        worktreeIncarnationId,
        metadataBaseRefName: sourcePlan.metadataBaseRefName,
      });
      mkdirSync(dirname(normalizedCandidatePath), { recursive: true });
      try {
        mkdirSync(normalizedCandidatePath);
        finalWorktreePath = normalizedCandidatePath;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        finalWorktreePath = `${worktreePath}-${pathSuffix}`;
        pathSuffix++;
      }
    }
  } else {
    mkdirSync(dirname(finalWorktreePath), { recursive: true });
    while (existsSync(finalWorktreePath)) {
      finalWorktreePath = `${worktreePath}-${pathSuffix}`;
      pathSuffix++;
    }
  }

  const normalizedWorktreePath = normalizePathForOwnership(finalWorktreePath);
  if (onWorktreePathPlanned && onWorktreePathResolved) {
    const markerPath = join(normalizedWorktreePath, WORKTREE_CREATION_MARKER_FILENAME);
    try {
      writeFileSync(markerPath, `${worktreeIncarnationId}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const directoryStat = statSync(normalizedWorktreePath, { bigint: true });
      await onWorktreePathResolved(normalizedWorktreePath, {
        worktreeIncarnationId,
        directoryIdentity: {
          device: directoryStat.dev.toString(),
          inode: directoryStat.ino.toString(),
        },
        metadataBaseRefName: sourcePlan.metadataBaseRefName,
      });
      unlinkSync(markerPath);
    } catch (error) {
      rmSync(normalizedWorktreePath, { recursive: true, force: true });
      throw error;
    }
  }

  // Primitive owner for `git worktree add`; callers route through createWorktreeCore.
  await runGitCommand(["worktree", "add", finalWorktreePath, ...sourcePlan.addArguments], {
    cwd,
    timeout: 120_000,
  });
  worktreePath = normalizedWorktreePath;

  if (sourcePlan.pushRemote) {
    await configureWorktreePushRemote({
      cwd,
      branchName: sourcePlan.branchName,
      remote: sourcePlan.pushRemote,
    });
  }
  if (sourcePlan.trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd,
      branchName: sourcePlan.branchName,
      remote: sourcePlan.trackingRemote,
    });
  }

  writePaseoWorktreeMetadata(worktreePath, {
    baseRefName: sourcePlan.metadataBaseRefName,
    incarnationId: worktreeIncarnationId,
    ...(sourcePlan.changeRequestLookupTarget
      ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
      : {}),
  });

  await seedPaseoConfigFile({ sourceCwd: cwd, targetCwd: worktreePath });

  if (runSetup) {
    await runWorktreeSetupCommands({
      worktreePath,
      branchName: sourcePlan.branchName,
      cleanupOnFailure: true,
    });
  }

  return {
    branchName: sourcePlan.branchName,
    worktreePath,
  };
};

interface ResolveWorktreeSourcePlanOptions {
  cwd: string;
  source: WorktreeSource;
  desiredSlug: string;
}

interface WorktreeSourcePlan {
  branchName: string;
  metadataBaseRefName: string;
  changeRequestLookupTarget?: PaseoWorktreeChangeRequestLookupTarget;
  addArguments: string[];
  pushRemote?: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
  trackingRemote?: {
    name: string;
    headRef: string;
  };
}

async function resolveWorktreeSourcePlan({
  cwd,
  source,
  desiredSlug,
}: ResolveWorktreeSourcePlanOptions): Promise<WorktreeSourcePlan> {
  switch (source.kind) {
    case "branch-off": {
      const branchName = source.branchName;
      validateWorktreeBranchName(branchName);
      const normalizedBaseBranch = normalizeRequiredBaseBranch(source.baseBranch);
      const resolvedBaseBranch = await resolveBaseBranchForWorktree(cwd, normalizedBaseBranch);
      const branchExists = await localBranchExists(cwd, branchName);
      const base = branchExists ? branchName : resolvedBaseBranch;
      const candidateBranch = branchExists ? desiredSlug : branchName;
      const newBranchName = await resolveUniqueLocalBranchName(cwd, candidateBranch);

      return {
        branchName: newBranchName,
        metadataBaseRefName: normalizedBaseBranch,
        addArguments: ["-b", newBranchName, "--no-track", base],
      };
    }
    case "checkout-branch": {
      await validateExistingWorktreeBranchName(cwd, source.branchName);
      if (!(await localBranchExists(cwd, source.branchName))) {
        try {
          await runGitCommand(["fetch", "origin", `${source.branchName}:${source.branchName}`], {
            cwd,
            timeout: 120_000,
          });
        } catch {
          throw new UnknownBranchError({ branchName: source.branchName, cwd });
        }
      }
      if (await isBranchCheckedOut(cwd, source.branchName)) {
        throw new BranchAlreadyCheckedOutError(source.branchName);
      }

      return {
        branchName: source.branchName,
        metadataBaseRefName: source.branchName,
        addArguments: [source.branchName],
      };
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      const localBranchCandidate = source.localBranchName ?? source.headRef;
      await validateExistingWorktreeBranchName(cwd, localBranchCandidate);
      const localBranchName = await resolveUniqueLocalBranchName(cwd, localBranchCandidate);
      const normalizedBaseRefName = normalizeRequiredBaseBranch(source.baseRefName);
      const changeRequestNumber =
        source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
      await fetchWorktreeCheckoutRefs({
        cwd,
        localBranchName,
        checkoutRefs: source.checkoutRefs ?? [
          { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
        ],
      });
      const shouldTrackOriginHead = source.trackOriginHead === true;
      const trackingRemote = shouldTrackOriginHead
        ? await tryFetchWorktreeTrackingRemote({
            cwd,
            remoteName: "origin",
            headRef: source.headRef,
          })
        : undefined;
      const remotePlan: Pick<WorktreeSourcePlan, "pushRemote" | "trackingRemote"> = {};
      if (source.pushRemoteUrl) {
        const remoteName = `paseo-pr-${changeRequestNumber}`;
        remotePlan.pushRemote = {
          name: remoteName,
          url: source.pushRemoteUrl,
          headRef: source.headRef,
          track: true,
        };
      } else if (shouldTrackOriginHead && localBranchName !== source.headRef) {
        const originUrl = await getWorktreeRemotePushUrl(cwd, "origin");
        if (originUrl) {
          remotePlan.pushRemote = {
            name: `paseo-pr-${changeRequestNumber}`,
            url: originUrl,
            headRef: source.headRef,
            track: false,
          };
        }
      }
      if (trackingRemote) {
        remotePlan.trackingRemote = trackingRemote;
      }

      return {
        branchName: localBranchName,
        metadataBaseRefName: normalizedBaseRefName,
        changeRequestLookupTarget: {
          headRef: source.headRef,
          ...(source.headRepositoryOwner
            ? { headRepositoryOwner: source.headRepositoryOwner }
            : {}),
          changeRequestNumber,
        },
        addArguments: [localBranchName],
        ...remotePlan,
      };
    }
  }
}

async function configureWorktreePushRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
}): Promise<void> {
  await runGitCommand(["config", `remote.${options.remote.name}.url`, options.remote.url], {
    cwd: options.cwd,
  });
  await runGitCommand(
    ["config", `remote.${options.remote.name}.push`, `HEAD:refs/heads/${options.remote.headRef}`],
    { cwd: options.cwd },
  );
  await runGitCommand(["config", `branch.${options.branchName}.pushRemote`, options.remote.name], {
    cwd: options.cwd,
  });
  if (!options.remote.track) {
    return;
  }
  await runGitCommand(
    [
      "config",
      `remote.${options.remote.name}.fetch`,
      `+refs/heads/${options.remote.headRef}:refs/remotes/${options.remote.name}/${options.remote.headRef}`,
    ],
    { cwd: options.cwd },
  );
  const trackingRemote = await tryFetchWorktreeTrackingRemote({
    cwd: options.cwd,
    remoteName: options.remote.name,
    headRef: options.remote.headRef,
  });
  if (trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd: options.cwd,
      branchName: options.branchName,
      remote: trackingRemote,
    });
  }
}

async function fetchWorktreeCheckoutRefs(options: {
  cwd: string;
  localBranchName: string;
  checkoutRefs: WorktreeCheckoutRef[];
}): Promise<void> {
  let lastResult:
    | Awaited<ReturnType<typeof runGitCommand>>
    | { stderr: string; stdout: string; exitCode: number | null }
    | null = null;
  for (const checkoutRef of options.checkoutRefs) {
    lastResult = await runGitCommand(
      [
        "fetch",
        checkoutRef.remoteName ?? "origin",
        `+${checkoutRef.remoteRef}:refs/heads/${options.localBranchName}`,
        "--force",
      ],
      {
        cwd: options.cwd,
        timeout: 120_000,
        acceptExitCodes: [0, 1, 128],
      },
    );
    if (lastResult.exitCode === 0) {
      return;
    }
  }
  const attemptedRefs = options.checkoutRefs
    .map((checkoutRef) => `${checkoutRef.remoteName ?? "origin"} ${checkoutRef.remoteRef}`)
    .join(", ");
  throw new Error(
    `Unable to fetch change request refs for worktree branch ${options.localBranchName}: ${attemptedRefs}${lastResult?.stderr ? `\n${lastResult.stderr}` : ""}`,
  );
}

async function tryFetchWorktreeTrackingRemote(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<{ name: string; headRef: string } | undefined> {
  const result = await runGitCommand(
    [
      "fetch",
      options.remoteName,
      `+refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`,
    ],
    {
      cwd: options.cwd,
      timeout: 120_000,
      acceptExitCodes: [0, 1, 128],
    },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  await ensureRemoteFetchesBranch(options);
  return { name: options.remoteName, headRef: options.headRef };
}

async function ensureRemoteFetchesBranch(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<void> {
  const configKey = `remote.${options.remoteName}.fetch`;
  const exactRefspec = `refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`;
  const wildcardRefspec = `refs/heads/*:refs/remotes/${options.remoteName}/*`;
  const { stdout } = await runGitCommand(["config", "--get-all", configKey], {
    cwd: options.cwd,
    acceptExitCodes: [0, 1],
  });
  const alreadyTracked = stdout
    .split("\n")
    .map((refspec) => refspec.trim().replace(/^\+/, ""))
    .some((refspec) => refspec === exactRefspec || refspec === wildcardRefspec);
  if (alreadyTracked) {
    return;
  }
  await runGitCommand(["config", "--add", configKey, `+${exactRefspec}`], { cwd: options.cwd });
}

async function getWorktreeRemotePushUrl(
  cwd: string,
  remoteName: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(["remote", "get-url", "--push", remoteName], {
      cwd,
    });
    const url = stdout.trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

async function configureWorktreeTrackingRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    headRef: string;
  };
}): Promise<void> {
  await runGitCommand(
    [
      "branch",
      "--set-upstream-to",
      `${options.remote.name}/${options.remote.headRef}`,
      options.branchName,
    ],
    { cwd: options.cwd },
  );
}

function validateWorktreeBranchName(branchName: string): void {
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }
}

async function validateExistingWorktreeBranchName(cwd: string, branchName: string): Promise<void> {
  const result = await runGitCommand(["check-ref-format", "--branch", branchName], {
    cwd,
    timeout: 30_000,
    acceptExitCodes: [0, 1, 128],
  });
  if (result.exitCode !== 0) {
    throw new InvalidGitBranchNameError(branchName);
  }
}

function normalizeRequiredBaseBranch(baseBranch: string): string {
  const normalizedBaseBranch = normalizeBaseRefName(baseBranch);
  if (!normalizedBaseBranch) {
    throw new Error("Base branch is required when creating a Paseo worktree");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD when creating a Paseo worktree");
  }
  return normalizedBaseBranch;
}

async function resolveBaseBranchForWorktree(
  cwd: string,
  normalizedBaseBranch: string,
): Promise<string> {
  try {
    await runGitCommand(["rev-parse", "--verify", `origin/${normalizedBaseBranch}`], { cwd });
    return `origin/${normalizedBaseBranch}`;
  } catch {
    try {
      await runGitCommand(["rev-parse", "--verify", normalizedBaseBranch], { cwd });
      return normalizedBaseBranch;
    } catch {
      throw new Error(`Base branch not found: ${normalizedBaseBranch}`);
    }
  }
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveUniqueLocalBranchName(cwd: string, candidateBranch: string): Promise<string> {
  let newBranchName = candidateBranch;
  let suffix = 1;
  while (await localBranchExists(cwd, newBranchName)) {
    newBranchName = `${candidateBranch}-${suffix}`;
    suffix++;
  }
  return newBranchName;
}

async function isBranchCheckedOut(cwd: string, branchName: string): Promise<boolean> {
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return parseWorktreeList(stdout).some((entry) => entry.branchName === branchName);
}
