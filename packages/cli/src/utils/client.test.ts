import { describe, expect, it, test } from "vitest";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { createCliDaemonClient, installBoundedWebSocketClose } from "./client";

test("CLI clients explicitly opt out of provider child streams", async () => {
  const sent: string[] = [];
  let open: () => void = () => {};
  let message: (data: unknown) => void = () => {};
  const transport: DaemonTransport = {
    send(data) {
      if (typeof data === "string") sent.push(data);
    },
    close() {},
    onOpen(handler) {
      open = handler;
      return () => {};
    },
    onMessage(handler) {
      message = handler;
      return () => {};
    },
    onClose() {
      return () => {};
    },
    onError() {
      return () => {};
    },
  };
  const client = createCliDaemonClient({
    url: "ws://test",
    clientId: "cli-capability-test",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });

  const connecting = client.connect();
  open();
  message(
    JSON.stringify({
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", serverId: "test", hostname: null, version: null },
      },
    }),
  );
  await connecting;

  const hello = JSON.parse(sent[0]) as {
    clientType: string;
    appVersion: string;
    capabilities: Record<string, unknown>;
  };
  expect(hello.clientType).toBe("cli");
  expect(hello.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(hello.capabilities[CLIENT_CAPS.providerSubagents]).toBe(false);
  await client.close();
});

class FakeCliWebSocket {
  readyState = 1;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminateCalls = 0;
  private closeListeners: Array<() => void> = [];

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  terminate(): void {
    this.terminateCalls++;
  }

  once(event: "close", listener: () => void): void {
    if (event === "close") {
      this.closeListeners.push(listener);
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners.splice(0)) {
      listener();
    }
  }
}

function createFakeTimers() {
  class FakeTimer {
    cleared = false;
    unrefCalls = 0;

    constructor(
      readonly callback: () => void,
      readonly delayMs: number,
    ) {}

    unref(): void {
      this.unrefCalls++;
    }
  }

  const scheduled: FakeTimer[] = [];

  const timers = {
    setTimeout(callback, delayMs) {
      const timer = new FakeTimer(callback, delayMs);
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timerHandle) {
      const timer = scheduled.find((entry) => entry === timerHandle);
      if (timer) {
        timer.cleared = true;
      }
    },
  } satisfies NonNullable<Parameters<typeof installBoundedWebSocketClose>[1]>;

  return { scheduled, timers };
}

describe("installBoundedWebSocketClose", () => {
  it("unrefs and terminates a socket whose close handshake does not complete", () => {
    const socket = new FakeCliWebSocket();
    const { scheduled, timers } = createFakeTimers();
    installBoundedWebSocketClose(socket, timers, 25);

    socket.close(1000, "command complete");

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "command complete" }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ delayMs: 25, cleared: false, unrefCalls: 1 });

    scheduled[0]?.callback();

    expect(socket.terminateCalls).toBe(1);
  });

  it("cancels termination when graceful close completes first", () => {
    const socket = new FakeCliWebSocket();
    const { scheduled, timers } = createFakeTimers();
    installBoundedWebSocketClose(socket, timers, 25);

    socket.close();
    socket.emitClose();
    scheduled[0]?.callback();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ cleared: true, unrefCalls: 1 });
    expect(socket.terminateCalls).toBe(0);
  });
});
