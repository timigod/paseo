import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { TimelineProjectionEntry } from "./timeline-projection.js";
import { analyzeMaterialProgress } from "./material-progress.js";

function entry(seq: number, item: AgentTimelineItem, timestamp = `2026-07-31T00:00:0${seq}.000Z`) {
  return {
    item,
    timestamp,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
  } satisfies TimelineProjectionEntry;
}

describe("analyzeMaterialProgress", () => {
  it("warns after one compaction and stalls after two in the current continuation", () => {
    const first = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "old work" }),
        entry(2, { type: "compaction", status: "completed" }),
        entry(3, { type: "user_message", text: "continue" }),
        entry(4, { type: "reasoning", text: "working" }),
        entry(5, { type: "compaction", status: "completed" }),
      ],
      turnOutcome: null,
    });

    expect(first).toEqual({
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "One compaction completed without later material progress.",
    });

    const second = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "continue" }),
        entry(2, { type: "compaction", status: "completed" }),
        entry(3, { type: "todo", items: [{ text: "ship", completed: false }] }),
        entry(4, { type: "compaction", status: "completed" }),
      ],
      turnOutcome: null,
    });

    expect(second).toEqual({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "Two compactions completed without later material progress.",
    });
  });

  it("treats completed edits and writes as material progress", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "implement" }),
        entry(2, { type: "compaction", status: "completed" }),
        entry(3, {
          type: "tool_call",
          callId: "edit-1",
          name: "edit",
          status: "completed",
          error: null,
          detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "+change" },
        }),
        entry(4, { type: "compaction", status: "completed" }),
        entry(5, {
          type: "tool_call",
          callId: "write-1",
          name: "write",
          status: "completed",
          error: null,
          detail: { type: "write", filePath: "src/b.ts", content: "content" },
        }),
      ],
      turnOutcome: null,
    });

    expect(result).toEqual({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: "2026-07-31T00:00:05.000Z",
      lastMaterialProgressKind: "write",
      reason: "Material progress followed the latest user message.",
    });
  });

  it("does not count reads, searches, fetches, failed shells, or commentary as material", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "investigate" }),
        entry(2, {
          type: "tool_call",
          callId: "read-1",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "src/a.ts", content: "source" },
        }),
        entry(3, {
          type: "tool_call",
          callId: "search-1",
          name: "grep",
          status: "completed",
          error: null,
          detail: { type: "search", query: "TODO", numMatches: 3 },
        }),
        entry(4, {
          type: "tool_call",
          callId: "fetch-1",
          name: "fetch",
          status: "completed",
          error: null,
          detail: { type: "fetch", url: "https://example.com", result: "response" },
        }),
        entry(5, {
          type: "tool_call",
          callId: "shell-1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "false", output: "failed", exitCode: 1 },
        }),
        entry(6, { type: "assistant_message", text: "Still investigating." }),
        entry(7, { type: "compaction", status: "completed" }),
      ],
      turnOutcome: null,
    });

    expect(result).toEqual({
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "One compaction completed without later material progress.",
    });
  });

  it("does not treat unclassified read-only shell output or child compaction logs as material", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "continue" }),
        entry(2, { type: "compaction", status: "completed" }),
        entry(3, {
          type: "tool_call",
          callId: "shell-read",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "rg TODO", output: "three matches", exitCode: 0 },
        }),
        entry(4, {
          type: "tool_call",
          callId: "child-1",
          name: "task",
          status: "completed",
          error: null,
          detail: { type: "sub_agent", log: "[Compacted]" },
        }),
        entry(5, { type: "compaction", status: "completed" }),
      ],
      turnOutcome: null,
    });

    expect(result).toEqual({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "Two compactions completed without later material progress.",
    });
  });

  it("counts only the final assistant message on a terminal turn", () => {
    const entries = [
      entry(1, { type: "user_message", text: "answer" }),
      entry(2, { type: "assistant_message", text: "I am checking." }),
      entry(3, { type: "compaction", status: "completed" }),
      entry(4, { type: "assistant_message", text: "Delivered result." }),
    ];

    expect(analyzeMaterialProgress({ entries, turnOutcome: null }).state).toBe("warning");
    expect(analyzeMaterialProgress({ entries, turnOutcome: "completed" })).toEqual({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: "2026-07-31T00:00:04.000Z",
      lastMaterialProgressKind: "assistant_result",
      reason: "Material progress followed the latest user message.",
    });

    expect(analyzeMaterialProgress({ entries, turnOutcome: "canceled" }).state).toBe("warning");
  });

  it("uses completion sequence order and safely handles unavailable history and timestamps", () => {
    const completedAfterCompaction = entry(2, {
      type: "tool_call",
      callId: "write-1",
      name: "write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "proof.txt", content: "passed" },
    });
    completedAfterCompaction.seqStart = 2;
    completedAfterCompaction.seqEnd = 4;
    completedAfterCompaction.timestamp = "not-a-timestamp";

    expect(
      analyzeMaterialProgress({
        entries: [
          entry(1, { type: "user_message", text: "test" }),
          completedAfterCompaction,
          entry(3, { type: "compaction", status: "completed" }),
        ],
        turnOutcome: null,
      }),
    ).toEqual({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: "write",
      reason: "Material progress followed the latest user message.",
    });

    expect(analyzeMaterialProgress({ entries: null, turnOutcome: null })).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "Timeline history is unavailable.",
    });
  });
});
