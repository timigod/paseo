import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const logger = createTestLogger();
const temporaryDirectories: string[] = [];

async function createStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "file-agent-timeline-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FileAgentTimelineStore", () => {
  it("persists an empty incarnation and its rows, then mints a new epoch after deletion", async () => {
    const directory = await createStoreDirectory();
    const agentId = "agent-with-durable-incarnation";
    const epochs = ["epoch-one", "epoch-two"];
    const store = new FileAgentTimelineStore(directory, logger, {
      epochFactory: () => epochs.shift() ?? "unexpected-epoch",
    });

    await expect(store.fetchCommitted(agentId, { limit: 0 })).resolves.toMatchObject({
      epoch: "epoch-one",
      rows: [],
      window: { nextSeq: 1 },
    });
    await expect(
      new FileAgentTimelineStore(directory, logger).fetchCommitted(agentId, { limit: 0 }),
    ).resolves.toMatchObject({ epoch: "epoch-one", rows: [], window: { nextSeq: 1 } });

    await store.bulkInsert(agentId, [
      {
        seq: 1,
        timestamp: "2026-08-01T00:00:00.000Z",
        item: { type: "assistant_message", text: "durable row" },
      },
    ]);
    await expect(
      new FileAgentTimelineStore(directory, logger).fetchCommitted(agentId, { limit: 0 }),
    ).resolves.toMatchObject({
      epoch: "epoch-one",
      rows: [{ seq: 1, item: { type: "assistant_message", text: "durable row" } }],
      window: { nextSeq: 2 },
    });

    await store.deleteAgent(agentId);
    await expect(store.fetchCommitted(agentId, { limit: 0 })).resolves.toMatchObject({
      epoch: "epoch-two",
      rows: [],
      window: { nextSeq: 1 },
    });
  });

  it("atomically keeps prior truth after a failed complete replacement", async () => {
    const directory = await createStoreDirectory();
    const agentId = "agent-with-atomic-history";
    let rejectWrites = false;
    const epochs = ["prior-epoch", "failed-replacement-epoch", "replacement-epoch"];
    const store = new FileAgentTimelineStore(directory, logger, {
      epochFactory: () => epochs.shift() ?? "unexpected-epoch",
      writeJson: async (filePath, value) => {
        if (rejectWrites) throw new Error("injected pre-rename failure");
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const priorRows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "prior complete timeline" },
      },
    ];
    const replacementRows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-01T00:00:00.000Z",
        item: { type: "user_message", text: "replacement row one" },
      },
      {
        seq: 2,
        timestamp: "2026-02-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "replacement row two" },
      },
    ];

    await store.bulkInsert(agentId, priorRows);
    expect((await store.fetchCommitted(agentId, { limit: 0 })).epoch).toBe("prior-epoch");
    rejectWrites = true;
    await expect(store.replaceCommitted(agentId, replacementRows)).rejects.toThrow(
      "injected pre-rename failure",
    );

    const restartedAfterFailure = new FileAgentTimelineStore(directory, logger);
    await expect(restartedAfterFailure.getCommittedRows(agentId)).resolves.toEqual(priorRows);
    await expect(
      restartedAfterFailure.fetchCommitted(agentId, { limit: 0 }),
    ).resolves.toMatchObject({ epoch: "prior-epoch" });

    rejectWrites = false;
    await expect(store.replaceCommitted(agentId, replacementRows)).resolves.toEqual({
      epoch: "replacement-epoch",
    });
    await expect(
      new FileAgentTimelineStore(directory, logger).fetchCommitted(agentId, { limit: 0 }),
    ).resolves.toMatchObject({
      epoch: "replacement-epoch",
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      rows: replacementRows,
    });
  });
});
