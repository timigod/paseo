import { expect, it } from "vitest";
import { DAEMON_STATUS_PROBE_TIMEOUT_MS } from "./status.js";

it("keeps a bounded status probe that tolerates a busy control plane", () => {
  expect(DAEMON_STATUS_PROBE_TIMEOUT_MS).toBe(5_000);
});
