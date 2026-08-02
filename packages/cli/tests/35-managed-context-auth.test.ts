#!/usr/bin/env npx tsx

import assert from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestPaseoDaemon } from "../../server/src/server/test-utils/paseo-daemon.ts";
import { runLocalPaseo } from "./helpers/local-cli.ts";

console.log("=== Managed Context Auth ===\n");

const daemon = await createTestPaseoDaemon();

async function createAgent() {
  return daemon.daemon.agentManager.createAgent(
    {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "full-access",
      cwd: process.cwd(),
    },
    undefined,
    { workspaceId: undefined },
  );
}

try {
  await writeFile(
    join(daemon.paseoHome, "paseo.pid"),
    `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: "managed-context-auth-test",
      uid: process.getuid?.(),
      listen: `0.0.0.0:${daemon.port}`,
    })}\n`,
  );

  const omittedTarget = await createAgent();
  const omitted = await runLocalPaseo(["agent", "delete", omittedTarget.id, "--json"], {
    PASEO_HOME: daemon.paseoHome,
    PASEO_HOST: `127.0.0.1:${daemon.port}`,
    PASEO_MANAGED_AGENT_CONTEXT: "1",
    PASEO_AGENT_ID: "",
    PASEO_AGENT_INCARNATION: "",
    PASEO_AGENT_AUTH_TOKEN: "",
    PASEO_PASSWORD: "ignored-managed-password",
  });
  assert.strictEqual(omitted.exitCode, 0, omitted.stderr || omitted.stdout);
  assert(
    daemon.daemon.agentManager.getAgent(omittedTarget.id),
    "managed omission must not consume the readable local coordinator routing file",
  );

  const caller = await createAgent();
  const invalidTokenTarget = await createAgent();
  const callerIdentity = daemon.daemon.agentManager.getAgentCallerIdentity(caller.id);
  assert(callerIdentity, "expected current managed caller identity");
  const invalidToken = await runLocalPaseo(["agent", "delete", invalidTokenTarget.id, "--json"], {
    PASEO_HOME: daemon.paseoHome,
    PASEO_HOST: `127.0.0.1:${daemon.port}`,
    PASEO_MANAGED_AGENT_CONTEXT: "1",
    PASEO_AGENT_ID: callerIdentity.agentId,
    PASEO_AGENT_INCARNATION: callerIdentity.incarnation,
    PASEO_AGENT_AUTH_TOKEN: "invalid-agent-token",
    PASEO_PASSWORD: "ignored-managed-password",
  });
  assert.strictEqual(invalidToken.exitCode, 0, invalidToken.stderr || invalidToken.stdout);
  assert(
    daemon.daemon.agentManager.getAgent(invalidTokenTarget.id),
    "invalid managed identity must not fall back to coordinator authority",
  );

  const validTokenTarget = await createAgent();
  const validAgentToken = daemon.daemon.agentManager.getAgentIngressAuthToken(caller.id);
  assert(validAgentToken, "expected managed caller ingress token");
  const valid = await runLocalPaseo(["agent", "delete", validTokenTarget.id, "--json"], {
    PASEO_HOME: daemon.paseoHome,
    PASEO_HOST: `127.0.0.1:${daemon.port}`,
    PASEO_MANAGED_AGENT_CONTEXT: "1",
    PASEO_AGENT_ID: callerIdentity.agentId,
    PASEO_AGENT_INCARNATION: callerIdentity.incarnation,
    PASEO_AGENT_AUTH_TOKEN: validAgentToken,
    PASEO_PASSWORD: "ignored-managed-password",
  });
  assert.strictEqual(valid.exitCode, 0, valid.stderr || valid.stdout);
  assert.strictEqual(
    daemon.daemon.agentManager.getAgent(validTokenTarget.id),
    null,
    "valid identity-bound managed operations remain available",
  );

  const trusted = await runLocalPaseo(["agent", "delete", omittedTarget.id, "--json"], {
    PASEO_HOME: daemon.paseoHome,
    PASEO_HOST: `127.0.0.1:${daemon.port}`,
    PASEO_MANAGED_AGENT_CONTEXT: "",
    PASEO_AGENT_ID: "",
    PASEO_AGENT_INCARNATION: "",
    PASEO_AGENT_AUTH_TOKEN: "",
    PASEO_PASSWORD: "",
  });
  assert.strictEqual(trusted.exitCode, 0, trusted.stderr || trusted.stdout);
  assert.strictEqual(
    daemon.daemon.agentManager.getAgent(omittedTarget.id),
    null,
    "trusted non-managed CLI retains passwordless local coordinator routing",
  );
} finally {
  await daemon.close();
}

console.log("=== Managed Context Auth Tests Passed ===");
