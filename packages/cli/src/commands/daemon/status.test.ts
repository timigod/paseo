import { describe, expect, test } from "vitest";
import { formatRuntimeCapacity, selectRelayStatus } from "./status.js";

describe("selectRelayStatus", () => {
  const persisted = {
    enabled: false,
    endpoint: "persisted.internal:443",
    publicEndpoint: "persisted.example.com:443",
    useTls: true,
    publicUseTls: true,
  };

  test("uses the running daemon relay state over persisted config", () => {
    expect(
      selectRelayStatus({
        persisted,
        live: {
          enabled: true,
          endpoint: "live.internal:443",
          publicEndpoint: "live.example.com:443",
          useTls: true,
          publicUseTls: true,
        },
      }),
    ).toBe("wss://live.example.com:443");
  });

  test("falls back to persisted config when the daemon cannot report live state", () => {
    expect(selectRelayStatus({ persisted })).toBe("disabled");
  });
});

describe("formatRuntimeCapacity", () => {
  test("shows the authoritative live, starting, limit, and available counts", () => {
    expect(formatRuntimeCapacity({ limit: 24, live: 7, starting: 1, available: 16 })).toBe(
      "7 live + 1 starting / 24; 16 available",
    );
  });

  test("shows an unbounded host without inventing a limit", () => {
    expect(formatRuntimeCapacity({ limit: null, live: 7, starting: 0, available: null })).toBe(
      "unlimited",
    );
  });
});
