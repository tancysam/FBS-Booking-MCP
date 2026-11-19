import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const repoRoot = new URL("../", import.meta.url);
const pluginRoot = new URL("plugins/smu-fbs-booking/", repoRoot);
const runtimeRoot = new URL("runtime/", pluginRoot);

if (!existsSync(new URL("dist/index.js", repoRoot)) || !existsSync(new URL("node_modules", repoRoot))) {
  console.error("Run npm ci to install dependencies and build the server before staging the plugin.");
  process.exit(1);
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot);
for (const item of ["package.json", "dist", "node_modules"]) {
  cpSync(new URL(item, repoRoot), new URL(item, runtimeRoot), { recursive: true });
}

// Use the Node executable that ran setup so desktop clients can launch it without the shell's PATH.
const config = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    fbs: {
      type: "stdio",
      command: process.execPath,
      args: ["${PLUGIN_ROOT}/runtime/dist/index.js"],
    },
  },
};

writeFileSync(new URL("mcp.json", pluginRoot), JSON.stringify(config, null, 2) + "\n");
