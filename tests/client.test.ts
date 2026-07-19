import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RoomClient } from "../src/client.js";
import type { RoomEvent } from "../src/types.js";

describe("RoomClient request timeout", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("aborts an ordinary request after the configured timeout", async () => {
    server = createServer(() => {
      // Deliberately leave this ordinary HTTP request unanswered.
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const client = new RoomClient(`http://127.0.0.1:${address.port}`, "dev", {
      requestTimeoutMs: 20,
    });
    await expect(client.snapshot()).rejects.toThrow("GET / timed out after 20ms");
  });

  it("warns that a timed-out mutation may still complete on the server", async () => {
    server = createServer(() => {
      // The client stops waiting, but this does not prove the server cancelled
      // work that may already have started.
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const client = new RoomClient(`http://127.0.0.1:${address.port}`, "dev", {
      requestTimeoutMs: 20,
    });
    await expect(client.send({
      senderId: "p_human",
      content: "hello",
    })).rejects.toThrow(
      "POST /messages timed out after 20ms; the server may still have applied the mutation",
    );
  });

  it("rejects non-positive and non-integer timeout configuration", () => {
    expect(() => new RoomClient("http://127.0.0.1:43110", "dev", {
      requestTimeoutMs: 0,
    })).toThrow("requestTimeoutMs must be a positive integer");
    expect(() => new RoomClient("http://127.0.0.1:43110", "dev", {
      requestTimeoutMs: 1.5,
    })).toThrow("requestTimeoutMs must be a positive integer");
  });

  it("aborts SSE reconnect catch-up without waiting for the request timeout", async () => {
    const event = messageEvent("evt_first", "first");
    let markCatchUpStarted!: () => void;
    const catchUpStarted = new Promise<void>((resolve) => {
      markCatchUpStarted = resolve;
    });
    server = createServer((req, res) => {
      if (req.url?.includes("/events?")) {
        markCatchUpStarted();
        return;
      }
      if (req.url?.endsWith("/stream")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const client = new RoomClient(`http://127.0.0.1:${address.port}`, "dev", {
      requestTimeoutMs: 2_000,
    });
    const controller = new AbortController();
    const received: RoomEvent[] = [];
    const stream = client.stream((receivedEvent) => received.push(receivedEvent), controller.signal);
    await withTimeout(catchUpStarted, 1_500, "SSE catch-up did not start");

    const abortedAt = Date.now();
    controller.abort();
    await stream;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(received.map((receivedEvent) => receivedEvent.id)).toEqual(["evt_first"]);
  });
});

function messageEvent(id: string, content: string): RoomEvent {
  const createdAt = "2026-07-19T00:00:00.000Z";
  return {
    id,
    room: "dev",
    type: "message",
    message: {
      id: `msg_${id}`,
      room: "dev",
      senderId: "p_human",
      senderName: "human",
      senderType: "human",
      content,
      mentions: [],
      createdAt,
    },
    createdAt,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
