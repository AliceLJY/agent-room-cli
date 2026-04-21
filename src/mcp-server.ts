#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RoomClient } from "./client.js";

interface Args {
  server: string;
  room: string;
  id: string;
  name: string;
}

const args = parseArgs(process.argv.slice(2));
const client = new RoomClient(args.server, args.room);

const server = new McpServer({
  name: "agent-room",
  version: "0.1.0",
});

server.tool(
  "send_message",
  "Send a message to the shared agent room. Use this for room-facing replies.",
  {
    content: z.string().min(1).describe("Message content to send to the room"),
  },
  async ({ content }) => {
    const message = await client.send({
      senderId: args.id,
      senderName: args.name,
      senderType: "agent",
      content,
    });
    return {
      content: [{ type: "text", text: `sent ${message.id}` }],
    };
  },
);

server.tool(
  "catch_up",
  "Read recent room messages.",
  {
    limit: z.number().int().min(1).max(100).default(30).optional(),
  },
  async ({ limit }) => {
    const messages = await client.messages(limit || 30);
    const lines = messages.map((message) =>
      `[${message.createdAt}] ${message.senderName}: ${message.content}`,
    );
    return {
      content: [{ type: "text", text: lines.join("\n") || "No room messages yet." }],
    };
  },
);

server.tool(
  "who",
  "List participants in the current room.",
  {},
  async () => {
    const snapshot = await client.snapshot();
    const lines = snapshot.participants.map((p) =>
      `@${p.identifier} (${p.name}) — ${p.type}/${p.client}, mode=${p.mode}`,
    );
    return {
      content: [{ type: "text", text: lines.join("\n") || "No participants." }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

function parseArgs(argv: string[]): Args {
  const result: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--server") result.server = value;
    if (key === "--room") result.room = value;
    if (key === "--id") result.id = value;
    if (key === "--name") result.name = value;
    if (key.startsWith("--")) i += 1;
  }
  for (const key of ["server", "room", "id", "name"] as const) {
    if (!result[key]) throw new Error(`missing --${key}`);
  }
  return result as Args;
}
