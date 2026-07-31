import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("fetch agent exposes a backward-compatible material progress signal", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.8",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    const fetched = await client.fetchAgent({ agentId: created.id });

    expect(fetched?.agent.materialProgress).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "No current continuation is available.",
    });
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetch agent preserves material progress after the live worker is collected", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.8",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-retained-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Retained material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "user_message",
      text: "implement",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "compaction",
      status: "completed",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "tool_call",
      callId: "write-1",
      name: "write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "proof.txt", content: "done" },
    });
    await daemon.daemon.agentManager.closeAgent(created.id);

    const fetched = await client.fetchAgent({ agentId: created.id });
    expect(fetched?.agent.materialProgress).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "write",
    });
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetch agent counts only an explicitly completed final result", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.8",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-completed-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Completed material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "user_message",
      text: "Say complete and nothing else",
    });
    await client.sendMessage(created.id, "Say complete and nothing else");
    await client.waitForFinish(created.id, 30_000);

    const fetched = await client.fetchAgent({ agentId: created.id });
    expect(fetched?.agent.materialProgress).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "assistant_result",
    });
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
