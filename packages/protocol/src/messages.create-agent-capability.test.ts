import { describe, expect, test } from "vitest";

import { CLIENT_CAPS } from "./client-capabilities.js";
import { WSHelloMessageSchema } from "./messages.js";

describe("extended create-agent timeout capability", () => {
  test("accepts capable and legacy hello messages without changing the wire shape", () => {
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "cli",
      protocolVersion: 1,
      capabilities: {
        [CLIENT_CAPS.extendedCreateAgentTimeout]: true,
      },
    });
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });

    expect(capable.capabilities?.[CLIENT_CAPS.extendedCreateAgentTimeout]).toBe(true);
    expect(legacy.capabilities).toBeUndefined();
  });
});
