import { describe, expect, test } from "vitest";

import { DaemonGetStatusResponseSchema } from "./messages.js";

function daemonStatus(runtimeCapacity?: {
  limit: number | null;
  live: number;
  reserved: number;
  free: number | null;
}) {
  return {
    type: "daemon.get_status.response",
    payload: {
      requestId: "status-1",
      serverId: "daemon-1",
      pid: 123,
      nodePath: "/usr/bin/node",
      listen: "127.0.0.1:6767",
      providers: [],
      ...(runtimeCapacity ? { runtimeCapacity } : {}),
    },
  };
}

describe("daemon runtime capacity status protocol", () => {
  test("accepts the authoritative finite runtime projection", () => {
    const parsed = DaemonGetStatusResponseSchema.parse(
      daemonStatus({ limit: 12, live: 10, reserved: 1, free: 1 }),
    );

    expect(parsed.payload.runtimeCapacity).toEqual({
      limit: 12,
      live: 10,
      reserved: 1,
      free: 1,
    });
  });

  test("accepts an unbounded runtime projection", () => {
    const parsed = DaemonGetStatusResponseSchema.parse(
      daemonStatus({ limit: null, live: 3, reserved: 0, free: null }),
    );

    expect(parsed.payload.runtimeCapacity).toEqual({
      limit: null,
      live: 3,
      reserved: 0,
      free: null,
    });
  });

  test("keeps status from older daemons valid when the projection is absent", () => {
    const parsed = DaemonGetStatusResponseSchema.parse(daemonStatus());

    expect(parsed.payload.runtimeCapacity).toBeUndefined();
  });
});
