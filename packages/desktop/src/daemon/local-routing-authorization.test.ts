import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { resolveLocalCoordinatorAuthorizationHeaders } from "./local-routing-authorization.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

test("omits the local coordinator routing capability in managed context", () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "desktop-local-routing-"));
  cleanupPaths.push(paseoHome);
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(join(paseoHome, "coordinator-auth-token"), "local-routing-token", "utf8");

  expect(
    resolveLocalCoordinatorAuthorizationHeaders(paseoHome, {
      PASEO_MANAGED_AGENT_CONTEXT: "1",
    }),
  ).toEqual({});
  expect(resolveLocalCoordinatorAuthorizationHeaders(paseoHome, {})).toEqual({
    Authorization: "Bearer local-routing-token",
  });
});
