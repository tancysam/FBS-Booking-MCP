import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserSession } from "../src/browser.js";
import { FbsClient } from "../src/client.js";
import { SessionError } from "../src/session.js";
import { registerTools } from "../src/tools.js";

async function connect(t: TestContext, openForSignIn: () => Promise<void>) {
  const browser: BrowserSession = {
    name: "Edge",
    isOpen: true,
    openForSignIn,
    fetch: async () => assert.fail("Login must not call the FBS API"),
    renew: async () => assert.fail("Login must not try to renew a failed sign-in"),
  };
  const fbs = new FbsClient(browser);
  const server = new McpServer({ name: "fbs-booking", version: "0.1.0" });
  registerTools(server, fbs);
  const client = new Client({ name: "test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, fbs };
}

test("fbs_login opens the browser without reporting an unverified sign-in", async (t) => {
  let opened = 0;
  const { client } = await connect(t, async () => { opened++; });
  const result = await client.callTool({ name: "fbs_login" });
  assert.equal(opened, 1);
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.content), /browser_open/);
  assert.match(JSON.stringify(result.content), /in the Edge window/);
  assert.match(JSON.stringify(result.content), /fbs_session_status/);
});

test("fbs_login does not accept credentials", async (t) => {
  let opened = false;
  const { client } = await connect(t, async () => { opened = true; });
  const result = await client.callTool({ name: "fbs_login", arguments: { password: "not-a-real-password" } });
  assert.equal(opened, false);
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result.content), /not-a-real-password/);
});

test("the server has no tool, argument or command that takes a cookie or token", async (t) => {
  const { client } = await connect(t, async () => {});
  const { tools } = await client.listTools();
  for (const tool of tools) {
    for (const name of Object.keys(tool.inputSchema.properties ?? {})) {
      assert.doesNotMatch(name, /cookie|client_?token|csrf|session|password/i, `${tool.name}.${name}`);
    }
  }
});

test("fbs_login does not pass browser errors with private URL data to the MCP client", async (t) => {
  const { client } = await connect(t, async () => { throw new SessionError("private-sign-in-url"); });
  const result = await client.callTool({ name: "fbs_login" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Could not open the SMU sign-in window/);
  assert.doesNotMatch(JSON.stringify(result.content), /private-sign-in-url/);
});

test("fbs_login waits before navigating the browser during another FBS operation", async (t) => {
  let opened = false;
  const { client, fbs } = await connect(t, async () => { opened = true; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operation = fbs.withSession(() => gate);
  const login = client.callTool({ name: "fbs_login" });
  try {
    await setImmediate();
    assert.equal(opened, false);
  } finally {
    release();
  }
  await operation;
  assert.equal((await login).isError, undefined);
  assert.equal(opened, true);
});
