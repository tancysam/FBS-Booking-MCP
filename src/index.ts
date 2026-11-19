#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { DedicatedBrowser } from "./browser.js";
import { FbsClient } from "./client.js";
import { keepAliveMaxHours, keepAliveMinutes, legacySessionPath } from "./config.js";
import { startKeepAlive } from "./keepalive.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command && command !== "serve") {
    console.error(
      "Usage: fbs-mcp [serve]\n" +
        "Sign-in happens in a dedicated Chrome, Edge or Brave window: ask your assistant to run fbs_login.",
    );
    process.exit(2);
  }
  if (fs.existsSync(legacySessionPath())) {
    console.error(
      `[fbs] ${legacySessionPath()} is left over from an older version. It is no longer read, ` +
        "but it still holds FBS cookies: delete it.",
    );
  }

  const server = new McpServer({ name: "fbs-booking", version: "0.1.0" });
  server.server.registerCapabilities({ resources: {}, prompts: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  const browser = new DedicatedBrowser();
  const client = new FbsClient(browser);
  let stopKeepAlive: (() => void) | undefined;
  const close = () => {
    stopKeepAlive?.();
    void browser.close().catch(() => undefined);
  };
  process.stdin.once("end", close);
  server.server.onclose = close;
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
  const minutes = keepAliveMinutes();
  if (minutes > 0 && !process.stdin.readableEnded) {
    stopKeepAlive = startKeepAlive(client, {
      intervalMs: minutes * 60_000,
      maxIdleMs: keepAliveMaxHours() * 3_600_000,
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
