import { createHash } from "node:crypto";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import type { MaterialProgressPayload } from "../messages.js";
import type { ToolCallDetail, ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export type MaterialProgressKind = NonNullable<MaterialProgressPayload["lastMaterialProgressKind"]>;
export type MaterialProgressTurnOutcome = "completed" | "failed" | "canceled";

export interface MaterialProgressCheckpoint {
  timelineEpoch: string;
  continuationBoundarySeq: number | null;
  acceptedTurnId: string | null;
  turnOutcome: MaterialProgressTurnOutcome | null;
  observedThroughSeq: number;
  completedCompactionsSinceMaterialProgress: number;
  lastMaterialProgressAt: string | null;
  lastMaterialProgressKind: MaterialProgressKind | null;
  seenMaterialProgressFingerprints: string[];
  /**
   * Fixed-size Bloom filter for fingerprints evicted from the exact recent window.
   * Bloom membership can return a false positive and suppress genuinely new progress,
   * but it cannot grow with the timeline and resets at each accepted continuation.
   */
  seenMaterialProgressFingerprintBloom?: string;
  /** Older Bloom generations retained so rotation never re-admits an evicted replay. */
  seenMaterialProgressFingerprintBloomArchive?: string[];
  trailingAssistantFingerprint: string | null;
  trailingAssistantHasConcreteText: boolean;
  trailingAssistantAt: string | null;
  unavailableReason?: string;
}

const MaterialProgressKindSchema = z.enum([
  "edit",
  "write",
  "evidence",
  "verification",
  "decision",
  "assistant_result",
]);

export const MATERIAL_PROGRESS_FINGERPRINT_LIMIT = 256;
const MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES = 4096;
const MATERIAL_PROGRESS_FINGERPRINT_BLOOM_HASHES = 6;
const MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ARCHIVE_LIMIT = 3;
const MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ROTATION_RATIO = 0.35;
const MATERIAL_PROGRESS_FINGERPRINT_BLOOM_SATURATION_RATIO = 0.5;
const MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ENCODED_LENGTH =
  Math.ceil(MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES / 3) * 4;

export const MaterialProgressCheckpointSchema: z.ZodType<MaterialProgressCheckpoint> = z.object({
  timelineEpoch: z.string(),
  continuationBoundarySeq: z.number().int().positive().nullable(),
  acceptedTurnId: z.string().nullable(),
  turnOutcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  observedThroughSeq: z.number().int().nonnegative(),
  completedCompactionsSinceMaterialProgress: z.number().int().nonnegative(),
  lastMaterialProgressAt: z.string().nullable(),
  lastMaterialProgressKind: MaterialProgressKindSchema.nullable(),
  seenMaterialProgressFingerprints: z.array(z.string()),
  seenMaterialProgressFingerprintBloom: z
    .string()
    .length(MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ENCODED_LENGTH)
    .optional(),
  seenMaterialProgressFingerprintBloomArchive: z
    .array(z.string().length(MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ENCODED_LENGTH))
    .max(MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ARCHIVE_LIMIT)
    .optional(),
  trailingAssistantFingerprint: z.string().nullable(),
  trailingAssistantHasConcreteText: z.boolean(),
  trailingAssistantAt: z.string().nullable(),
  unavailableReason: z.string().optional(),
});

interface MaterialProgressEvent {
  kind: MaterialProgressKind;
  fingerprint: string;
}

type EditDetail = Extract<ToolCallDetail, { type: "edit" }>;
type WriteDetail = Extract<ToolCallDetail, { type: "write" }>;
type EvidenceDetail = Extract<ToolCallDetail, { type: "read" | "search" | "fetch" }>;
type SearchDetail = Extract<EvidenceDetail, { type: "search" }>;
type ShellDetail = Extract<ToolCallDetail, { type: "shell" }>;
type PlanDetail = Extract<ToolCallDetail, { type: "plan" }>;

// Checkpoint arrays are immutable, so their identity can cache membership across timeline rows.
const fingerprintIndexes = new WeakMap<string[], ReadonlySet<string>>();
const verificationNameParts = new Set(["build", "check", "lint", "test", "typecheck", "verify"]);
const nonVerificationFlags = new Set(["--help", "--version", "-h", "-help", "-version"]);
const xcodebuildVerificationActions = new Set([
  "analyze",
  "archive",
  "build",
  "build-for-testing",
  "test",
]);
const verificationExecutables = new Set([
  "ava",
  "eslint",
  "jest",
  "mocha",
  "mypy",
  "oxlint",
  "py.test",
  "pyright",
  "pytest",
  "rspec",
  "stylelint",
  "tsc",
  "vitest",
  "vue-tsc",
]);

function fingerprintIndex(fingerprints: string[]): ReadonlySet<string> {
  const existing = fingerprintIndexes.get(fingerprints);
  if (existing) return existing;
  const created = new Set(fingerprints);
  fingerprintIndexes.set(fingerprints, created);
  return created;
}

function decodeFingerprintBloom(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES &&
    decoded.toString("base64") === value
    ? new Uint8Array(decoded)
    : null;
}

function fingerprintBloomSetRatio(bloom: Uint8Array): number {
  let setBits = 0;
  for (const byte of bloom) {
    let remaining = byte;
    while (remaining !== 0) {
      remaining &= remaining - 1;
      setBits += 1;
    }
  }
  return setBits / (MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES * 8);
}

interface FingerprintBloomHistory {
  archive: Uint8Array[];
  current: Uint8Array | null;
}

function readFingerprintBloomHistory(
  checkpoint: MaterialProgressCheckpoint,
): FingerprintBloomHistory | null {
  const encodedArchive = checkpoint.seenMaterialProgressFingerprintBloomArchive ?? [];
  if (encodedArchive.length > MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ARCHIVE_LIMIT) return null;

  const archive: Uint8Array[] = [];
  for (const encoded of encodedArchive) {
    const decoded = decodeFingerprintBloom(encoded);
    if (
      !decoded ||
      fingerprintBloomSetRatio(decoded) >= MATERIAL_PROGRESS_FINGERPRINT_BLOOM_SATURATION_RATIO
    ) {
      return null;
    }
    archive.push(decoded);
  }

  const current = decodeFingerprintBloom(checkpoint.seenMaterialProgressFingerprintBloom);
  if (
    checkpoint.seenMaterialProgressFingerprintBloom !== undefined &&
    (!current ||
      fingerprintBloomSetRatio(current) >= MATERIAL_PROGRESS_FINGERPRINT_BLOOM_SATURATION_RATIO)
  ) {
    return null;
  }
  return { archive, current };
}

function fingerprintBloomBitIndexes(fingerprint: string): number[] {
  const hash = createHash("sha256").update(fingerprint).digest();
  const bitCount = MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES * 8;
  return Array.from(
    { length: MATERIAL_PROGRESS_FINGERPRINT_BLOOM_HASHES },
    (_, index) => hash.readUInt32BE(index * 4) % bitCount,
  );
}

function addFingerprintToBloom(bloom: Uint8Array, fingerprint: string): void {
  for (const bitIndex of fingerprintBloomBitIndexes(fingerprint)) {
    bloom[Math.floor(bitIndex / 8)]! |= 1 << (bitIndex % 8);
  }
}

function fingerprintBloomMayContain(bloom: Uint8Array, fingerprint: string): boolean {
  return fingerprintBloomBitIndexes(fingerprint).every(
    (bitIndex) => (bloom[Math.floor(bitIndex / 8)]! & (1 << (bitIndex % 8))) !== 0,
  );
}

function encodeFingerprintBloom(bloom: Uint8Array): string {
  return Buffer.from(bloom).toString("base64");
}

function rotateFingerprintBloom(history: FingerprintBloomHistory): boolean {
  if (
    !history.current ||
    fingerprintBloomSetRatio(history.current) <
      MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ROTATION_RATIO ||
    history.archive.length >= MATERIAL_PROGRESS_FINGERPRINT_BLOOM_ARCHIVE_LIMIT
  ) {
    return false;
  }
  history.archive.push(history.current);
  history.current = new Uint8Array(MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES);
  return true;
}

function appendFingerprintToBloomHistory(
  history: FingerprintBloomHistory,
  fingerprint: string,
): boolean {
  rotateFingerprintBloom(history);
  history.current ??= new Uint8Array(MATERIAL_PROGRESS_FINGERPRINT_BLOOM_BYTES);
  addFingerprintToBloom(history.current, fingerprint);
  return (
    fingerprintBloomSetRatio(history.current) < MATERIAL_PROGRESS_FINGERPRINT_BLOOM_SATURATION_RATIO
  );
}

function withFingerprintBloomHistory(
  checkpoint: MaterialProgressCheckpoint,
  history: FingerprintBloomHistory,
): MaterialProgressCheckpoint {
  const {
    seenMaterialProgressFingerprintBloom: _discardedBloom,
    seenMaterialProgressFingerprintBloomArchive: _discardedArchive,
    ...rest
  } = checkpoint;
  return {
    ...rest,
    ...(history.current
      ? { seenMaterialProgressFingerprintBloom: encodeFingerprintBloom(history.current) }
      : {}),
    ...(history.archive.length > 0
      ? {
          seenMaterialProgressFingerprintBloomArchive: history.archive.map(encodeFingerprintBloom),
        }
      : {}),
  };
}

function invalidateFingerprintHistory(
  checkpoint: MaterialProgressCheckpoint,
): MaterialProgressCheckpoint {
  return emptyCheckpoint({
    timelineEpoch: checkpoint.timelineEpoch,
    observedThroughSeq: checkpoint.observedThroughSeq,
    unavailableReason:
      "Material progress is unavailable because fingerprint history is invalid or saturated.",
  });
}

export function boundMaterialProgressCheckpoint(
  checkpoint: MaterialProgressCheckpoint,
): MaterialProgressCheckpoint {
  const bloomHistory = readFingerprintBloomHistory(checkpoint);
  if (!bloomHistory) return invalidateFingerprintHistory(checkpoint);

  const retainedFingerprints = checkpoint.seenMaterialProgressFingerprints.slice(
    -MATERIAL_PROGRESS_FINGERPRINT_LIMIT,
  );
  const evictedCount =
    checkpoint.seenMaterialProgressFingerprints.length - retainedFingerprints.length;
  const bloomRotated = rotateFingerprintBloom(bloomHistory);
  if (evictedCount === 0 && !bloomRotated) {
    return checkpoint;
  }

  for (let index = 0; index < evictedCount; index += 1) {
    if (
      !appendFingerprintToBloomHistory(
        bloomHistory,
        checkpoint.seenMaterialProgressFingerprints[index]!,
      )
    ) {
      return invalidateFingerprintHistory(checkpoint);
    }
  }
  return withFingerprintBloomHistory(
    {
      ...checkpoint,
      seenMaterialProgressFingerprints: retainedFingerprints,
    },
    bloomHistory,
  );
}

function shellWords(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((word) =>
    word.replace(/^(["'])(.*)\1$/, "$2"),
  );
}

function executableName(value: string): string {
  return (
    value
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\.(?:cmd|exe)$/i, "")
      .toLowerCase() ?? ""
  );
}

function hasVerificationName(value: string | undefined): boolean {
  if (!value) return false;
  const name = executableName(value).replace(/\.(?:bash|sh|zsh)$/i, "");
  return name.split(/[:._-]+/).some((part) => verificationNameParts.has(part));
}

function firstNonOption(args: readonly string[]): string | undefined {
  return args.find((arg) => arg !== "--" && !arg.startsWith("-"));
}

function stripCommandPrefixes(words: string[]): string[] {
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    words.shift();
  }
  if (words[0] === "env") {
    words.shift();
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift();
    }
  }
  if (words[0] === "sudo" || words[0] === "command" || words[0] === "time") {
    words.shift();
  }

  return words;
}

function invokesVerificationExecutable(invoked: string | undefined): boolean {
  return verificationExecutables.has(executableName(invoked ?? "")) || hasVerificationName(invoked);
}

function isPackageManagerVerification(args: string[]): boolean {
  const action = args[0];
  if (action === "run") return hasVerificationName(args[1]);
  if (action === "exec" || action === "x") {
    return invokesVerificationExecutable(firstNonOption(args.slice(1)));
  }
  return hasVerificationName(action);
}

function isToolchainVerification(args: string[]): boolean {
  return args.some((arg) => hasVerificationName(arg) || arg === "clippy" || arg === "vet");
}

function isJvmBuildVerification(args: string[]): boolean {
  return args.some(
    (arg) =>
      hasVerificationName(arg) ||
      ["compile", "package", "verify"].includes(arg.replace(/^.*:/, "")),
  );
}

function isPythonVerification(args: string[]): boolean {
  const moduleIndex = args.indexOf("-m");
  return invokesVerificationExecutable(moduleIndex >= 0 ? args[moduleIndex + 1] : undefined);
}

function isMakeVerification(args: string[]): boolean {
  const targets = args.filter((arg) => !arg.startsWith("-"));
  return (
    args.length === 0 || targets.some((target) => hasVerificationName(target) || target === "all")
  );
}

function isXcodebuildVerification(args: string[]): boolean {
  return args.length === 0 || args.some((arg) => xcodebuildVerificationActions.has(arg));
}

type VerificationCommandDetector = (args: string[]) => boolean;

const verificationCommandDetectors: Readonly<Record<string, VerificationCommandDetector>> = {
  npm: isPackageManagerVerification,
  pnpm: isPackageManagerVerification,
  yarn: isPackageManagerVerification,
  bun: isPackageManagerVerification,
  npx: (args) => invokesVerificationExecutable(firstNonOption(args)),
  bunx: (args) => invokesVerificationExecutable(firstNonOption(args)),
  pnpx: (args) => invokesVerificationExecutable(firstNonOption(args)),
  biome: (args) => args.some((arg) => arg === "check" || arg === "lint"),
  prettier: (args) => args.includes("--check"),
  ruff: (args) => args[0] === "check" || args.includes("--check"),
  oxfmt: (args) => args.includes("--check"),
  cargo: isToolchainVerification,
  go: isToolchainVerification,
  dotnet: isToolchainVerification,
  swift: isToolchainVerification,
  zig: isToolchainVerification,
  gradle: isJvmBuildVerification,
  gradlew: isJvmBuildVerification,
  mvn: isJvmBuildVerification,
  mvnw: isJvmBuildVerification,
  python: isPythonVerification,
  python3: isPythonVerification,
  node: (args) => args.includes("--test"),
  cmake: (args) => args.includes("--build"),
  docker: (args) => args[0] === "build",
  make: isMakeVerification,
  xcodebuild: isXcodebuildVerification,
  bash: (args) => hasVerificationName(firstNonOption(args)),
  sh: (args) => hasVerificationName(firstNonOption(args)),
  zsh: (args) => hasVerificationName(firstNonOption(args)),
};

function isVerificationCommandSegment(segment: string): boolean {
  const words = stripCommandPrefixes(shellWords(segment.replace(/^[({\s]+/, "")));

  const executable = executableName(words[0] ?? "");
  const args = words.slice(1);
  if (!executable) return false;
  if (args.some((arg) => nonVerificationFlags.has(arg))) return false;
  if (verificationExecutables.has(executable) || hasVerificationName(executable)) return true;
  const detector = verificationCommandDetectors[executable];
  return Object.hasOwn(verificationCommandDetectors, executable) && detector(args);
}

function runsVerificationCommand(command: string): boolean {
  // Fallbacks, pipelines, and background jobs can hide the verification command's exit status.
  if (/\||(?<![>&])&(?![&>])/.test(command)) return false;
  const finalStatusSequence = command.split(/[;\n]+/).findLast((segment) => segment.trim()) ?? "";
  return finalStatusSequence.split(/&&/).some(isVerificationCommandSegment);
}

function hasConcreteText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function progressFingerprint(kind: MaterialProgressKind, result: unknown): string {
  return `${kind}:${digest(result)}`;
}

function progressEvent(kind: MaterialProgressKind, result: unknown): MaterialProgressEvent {
  return { kind, fingerprint: progressFingerprint(kind, result) };
}

function editEvent(detail: EditDetail): MaterialProgressEvent | null {
  const { filePath, oldString, newString, unifiedDiff } = detail;
  if (!hasConcreteText(unifiedDiff) && oldString !== undefined && oldString === newString) {
    return null;
  }
  if (!hasConcreteText(unifiedDiff) && oldString === undefined && newString === undefined) {
    return null;
  }
  return progressEvent("edit", { filePath, oldString, newString, unifiedDiff });
}

function writeEvent(detail: WriteDetail): MaterialProgressEvent | null {
  const { filePath, content } = detail;
  return content === undefined ? null : progressEvent("write", { filePath, content });
}

function hasSearchResult(detail: SearchDetail): boolean {
  return (
    hasConcreteText(detail.content) ||
    detail.numFiles !== undefined ||
    detail.numMatches !== undefined ||
    (detail.filePaths?.length ?? 0) > 0 ||
    (detail.webResults?.length ?? 0) > 0 ||
    (detail.annotations?.length ?? 0) > 0
  );
}

function evidenceEvent(detail: EvidenceDetail): MaterialProgressEvent | null {
  switch (detail.type) {
    case "read": {
      const { filePath, content } = detail;
      return hasConcreteText(content)
        ? progressEvent("evidence", { type: "read", filePath, content })
        : null;
    }
    case "search": {
      const { query, content, filePaths, webResults, annotations, numFiles, numMatches } = detail;
      return hasSearchResult(detail)
        ? progressEvent("evidence", {
            type: "search",
            query,
            content,
            filePaths,
            webResults,
            annotations,
            numFiles,
            numMatches,
          })
        : null;
    }
    case "fetch": {
      const { url, result, code, bytes } = detail;
      const succeeded =
        hasConcreteText(result) && (code === undefined || (code >= 200 && code < 400));
      return succeeded
        ? progressEvent("evidence", { type: "fetch", url, result, code, bytes })
        : null;
    }
  }
}

function hasAuthoritativeVerificationFailure(output: string): boolean {
  const plainOutput = stripAnsi(output);
  return plainOutput.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      /^(?:Test Files|Test Suites|Tests):?\s+[1-9]\d*\s+failed\b/.test(trimmed) ||
      /^FAIL\s+\S/.test(trimmed) ||
      /^(?:npm ERR!|npm error)\b.*(?:failed|error)\b/i.test(trimmed) ||
      /\berror TS\d+:/.test(trimmed) ||
      /^Found\s+(?=.*\b[1-9]\d*\s+errors?\b)\d+\s+(?:warnings?|errors?)(?:\s+and\s+\d+\s+(?:warnings?|errors?))?\.?$/.test(
        trimmed,
      ) ||
      /^[1-9]\d*\s+problems?\s+\([1-9]\d*\s+errors?\b/.test(trimmed) ||
      /^(?:Build failed|Failed to compile|error during build)\b/i.test(trimmed) ||
      /^ERROR in\s+\S/.test(trimmed)
    );
  });
}

function verificationEvent(detail: ShellDetail): MaterialProgressEvent | null {
  const { command, cwd, output, exitCode } = detail;
  return exitCode === 0 &&
    hasConcreteText(output) &&
    runsVerificationCommand(command) &&
    !hasAuthoritativeVerificationFailure(output)
    ? progressEvent("verification", { command, cwd, output, exitCode })
    : null;
}

function decisionEvent(detail: PlanDetail): MaterialProgressEvent | null {
  const text = detail.text.trim();
  return text ? progressEvent("decision", text) : null;
}

function materialToolEvent(item: ToolCallTimelineItem): MaterialProgressEvent | null {
  if (item.status !== "completed") return null;
  switch (item.detail.type) {
    case "edit":
      return editEvent(item.detail);
    case "write":
      return writeEvent(item.detail);
    case "read":
    case "search":
    case "fetch":
      return evidenceEvent(item.detail);
    case "shell":
      return verificationEvent(item.detail);
    case "plan":
      return decisionEvent(item.detail);
    case "worktree_setup":
    case "sub_agent":
    case "unknown":
    case "plain_text":
      return null;
  }
}

function validTimestamp(value: string): string | null {
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function emptyCheckpoint(input: {
  timelineEpoch: string;
  observedThroughSeq: number;
  unavailableReason?: string;
}): MaterialProgressCheckpoint {
  return {
    timelineEpoch: input.timelineEpoch,
    continuationBoundarySeq: null,
    acceptedTurnId: null,
    turnOutcome: null,
    observedThroughSeq: input.observedThroughSeq,
    completedCompactionsSinceMaterialProgress: 0,
    lastMaterialProgressAt: null,
    lastMaterialProgressKind: null,
    seenMaterialProgressFingerprints: [],
    trailingAssistantFingerprint: null,
    trailingAssistantHasConcreteText: false,
    trailingAssistantAt: null,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
  };
}

export function createMaterialProgressCheckpoint(input: {
  timelineEpoch: string;
  nextSeq: number;
}): MaterialProgressCheckpoint {
  return emptyCheckpoint({
    timelineEpoch: input.timelineEpoch,
    observedThroughSeq: Math.max(0, input.nextSeq - 1),
  });
}

export function restoreMaterialProgressCheckpoint(
  checkpoint: MaterialProgressCheckpoint,
  input: { timelineEpoch: string; nextSeq: number },
): MaterialProgressCheckpoint {
  const lastSeq = Math.max(0, input.nextSeq - 1);
  const boundaryIsValid =
    checkpoint.continuationBoundarySeq === null ||
    checkpoint.continuationBoundarySeq <= input.nextSeq;
  // Sequence bounds are not a continuity identity: replacement timelines can
  // have the same length or be longer. Only an unchanged epoch proves that the
  // checkpoint still describes these rows.
  const continuityIsProven = checkpoint.timelineEpoch === input.timelineEpoch;
  if (!continuityIsProven || !boundaryIsValid || checkpoint.observedThroughSeq > lastSeq) {
    return emptyCheckpoint({
      timelineEpoch: input.timelineEpoch,
      observedThroughSeq: lastSeq,
      unavailableReason:
        "Persisted material progress could not be proven to match the restored timeline.",
    });
  }
  return boundMaterialProgressCheckpoint(checkpoint);
}

export function invalidateMaterialProgressCheckpoint(input: {
  timelineEpoch: string;
  nextSeq: number;
  reason: string;
}): MaterialProgressCheckpoint {
  return emptyCheckpoint({
    timelineEpoch: input.timelineEpoch,
    observedThroughSeq: Math.max(0, input.nextSeq - 1),
    unavailableReason: input.reason,
  });
}

export function openMaterialProgressContinuation(input: {
  timelineEpoch: string;
  boundarySeq: number;
  turnId: string;
}): MaterialProgressCheckpoint {
  return {
    ...emptyCheckpoint({
      timelineEpoch: input.timelineEpoch,
      observedThroughSeq: Math.max(0, input.boundarySeq - 1),
    }),
    continuationBoundarySeq: input.boundarySeq,
    acceptedTurnId: input.turnId,
  };
}

function withTrailingAssistant(
  checkpoint: MaterialProgressCheckpoint,
  row: AgentTimelineRow,
): MaterialProgressCheckpoint {
  if (row.item.type !== "assistant_message") {
    return {
      ...checkpoint,
      trailingAssistantFingerprint: null,
      trailingAssistantHasConcreteText: false,
      trailingAssistantAt: null,
    };
  }
  const previous = checkpoint.trailingAssistantFingerprint;
  return {
    ...checkpoint,
    trailingAssistantFingerprint: digest(
      previous === null ? { text: row.item.text } : { previous, text: row.item.text },
    ),
    trailingAssistantHasConcreteText:
      checkpoint.trailingAssistantHasConcreteText || hasConcreteText(row.item.text),
    trailingAssistantAt: validTimestamp(row.timestamp),
  };
}

function recordMaterialEvent(
  checkpoint: MaterialProgressCheckpoint,
  event: MaterialProgressEvent | null,
  timestamp: string,
): MaterialProgressCheckpoint {
  if (
    !event ||
    fingerprintIndex(checkpoint.seenMaterialProgressFingerprints).has(event.fingerprint)
  ) {
    return checkpoint;
  }
  const bloomHistory = readFingerprintBloomHistory(checkpoint);
  if (!bloomHistory) return invalidateFingerprintHistory(checkpoint);
  if (
    bloomHistory.archive.some((bloom) => fingerprintBloomMayContain(bloom, event.fingerprint)) ||
    (bloomHistory.current && fingerprintBloomMayContain(bloomHistory.current, event.fingerprint))
  ) {
    return checkpoint;
  }
  const retainedFingerprintCount = MATERIAL_PROGRESS_FINGERPRINT_LIMIT - 1;
  const nextFingerprints =
    checkpoint.seenMaterialProgressFingerprints.slice(-retainedFingerprintCount);
  const evictedFingerprint =
    checkpoint.seenMaterialProgressFingerprints.length >= MATERIAL_PROGRESS_FINGERPRINT_LIMIT
      ? checkpoint.seenMaterialProgressFingerprints[0]
      : undefined;
  nextFingerprints.push(event.fingerprint);
  fingerprintIndexes.set(nextFingerprints, new Set(nextFingerprints));
  if (evictedFingerprint && !appendFingerprintToBloomHistory(bloomHistory, evictedFingerprint)) {
    return invalidateFingerprintHistory(checkpoint);
  }
  return withFingerprintBloomHistory(
    {
      ...checkpoint,
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: validTimestamp(timestamp),
      lastMaterialProgressKind: event.kind,
      seenMaterialProgressFingerprints: nextFingerprints,
    },
    bloomHistory,
  );
}

export function advanceMaterialProgressCheckpoint(
  checkpoint: MaterialProgressCheckpoint,
  row: AgentTimelineRow,
  timelineEpoch: string,
): MaterialProgressCheckpoint {
  if (checkpoint.timelineEpoch !== timelineEpoch) {
    return emptyCheckpoint({
      timelineEpoch,
      observedThroughSeq: row.seq,
      unavailableReason: "Material progress is unavailable because the timeline epoch changed.",
    });
  }
  if (row.seq <= checkpoint.observedThroughSeq) {
    return checkpoint;
  }
  if (row.seq !== checkpoint.observedThroughSeq + 1) {
    return emptyCheckpoint({
      timelineEpoch,
      observedThroughSeq: row.seq,
      unavailableReason: "Material progress is unavailable because timeline history is incomplete.",
    });
  }

  if (checkpoint.acceptedTurnId !== null && row.turnId !== checkpoint.acceptedTurnId) {
    return { ...checkpoint, observedThroughSeq: row.seq };
  }

  let next = withTrailingAssistant({ ...checkpoint, observedThroughSeq: row.seq }, row);
  if (checkpoint.continuationBoundarySeq === null || row.seq < checkpoint.continuationBoundarySeq) {
    return next;
  }

  const event = row.item.type === "tool_call" ? materialToolEvent(row.item) : null;
  next = recordMaterialEvent(next, event, row.timestamp);
  if (row.item.type === "compaction" && row.item.status === "completed") {
    next = {
      ...next,
      completedCompactionsSinceMaterialProgress: next.completedCompactionsSinceMaterialProgress + 1,
    };
  }
  return next;
}

export function settleMaterialProgressContinuation(
  checkpoint: MaterialProgressCheckpoint,
  input: { turnId: string; outcome: MaterialProgressTurnOutcome },
): MaterialProgressCheckpoint {
  if (checkpoint.acceptedTurnId !== input.turnId) return checkpoint;
  let next: MaterialProgressCheckpoint = { ...checkpoint, turnOutcome: input.outcome };
  if (
    input.outcome === "completed" &&
    checkpoint.trailingAssistantFingerprint !== null &&
    checkpoint.trailingAssistantHasConcreteText
  ) {
    next = recordMaterialEvent(
      next,
      {
        kind: "assistant_result",
        fingerprint: `assistant_result:${checkpoint.trailingAssistantFingerprint}`,
      },
      checkpoint.trailingAssistantAt ?? "",
    );
  }
  return next;
}

export function materialProgressPayload(
  checkpoint: MaterialProgressCheckpoint | null | undefined,
): MaterialProgressPayload {
  if (!checkpoint) {
    return {
      state: "none",
      timelineEpoch: null,
      continuationBoundarySeq: null,
      observedThroughSeq: null,
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "Material progress is unavailable from this stored agent snapshot.",
    };
  }

  const base = {
    timelineEpoch: checkpoint.timelineEpoch,
    continuationBoundarySeq: checkpoint.continuationBoundarySeq,
    observedThroughSeq: checkpoint.observedThroughSeq,
    completedCompactionsSinceMaterialProgress: checkpoint.completedCompactionsSinceMaterialProgress,
    lastMaterialProgressAt: checkpoint.lastMaterialProgressAt,
    lastMaterialProgressKind: checkpoint.lastMaterialProgressKind,
  };
  if (checkpoint.unavailableReason) {
    return { ...base, state: "none", reason: checkpoint.unavailableReason };
  }
  if (checkpoint.continuationBoundarySeq === null) {
    return {
      ...base,
      state: "none",
      reason: "No accepted continuation is available for the current timeline epoch.",
    };
  }
  if (checkpoint.completedCompactionsSinceMaterialProgress >= 2) {
    const count = checkpoint.completedCompactionsSinceMaterialProgress;
    return {
      ...base,
      state: "stalled",
      reason:
        count === 2
          ? "Two compactions completed without later distinct material progress."
          : `${count} compactions completed without later distinct material progress.`,
    };
  }
  if (checkpoint.completedCompactionsSinceMaterialProgress === 1) {
    return {
      ...base,
      state: "warning",
      reason: "One compaction completed without later distinct material progress.",
    };
  }
  if (checkpoint.lastMaterialProgressKind) {
    return {
      ...base,
      state: "progressing",
      reason: "Distinct material progress was recorded in the current accepted continuation.",
    };
  }
  return {
    ...base,
    state: "none",
    reason: "No material progress has been recorded for the current accepted continuation.",
  };
}
