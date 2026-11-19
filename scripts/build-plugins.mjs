import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = [
  {
    client: "claude",
    configFile: ".mcp.json",
    server: { args: ["${CLAUDE_PLUGIN_ROOT}/runtime/dist/index.js"] },
  },
  {
    client: "codex",
    configFile: "mcp.json",
    schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    server: {
      type: "stdio",
      cwd: ".",
      args: ["./runtime/dist/index.js"],
      env_vars: [
        "FBS_BROWSER",
        "FBS_BROWSER_EXECUTABLE",
        "FBS_CHROME_EXECUTABLE",
        "FBS_MCP_HOME",
        "FBS_KEEPALIVE_MINUTES",
        "FBS_KEEPALIVE_MAX_HOURS",
        "FBS_DEBUG",
      ],
    },
  },
];
const runtime = await mkdtemp(path.join(os.tmpdir(), "fbs-plugin-runtime-"));

try {
  // Install the locked production tree once and reuse it for both packages.
  for (const file of ["package.json", "package-lock.json"]) {
    await copyFile(path.join(root, file), path.join(runtime, file));
  }
  await cp(path.join(root, "dist"), path.join(runtime, "dist"), { recursive: true });
  execFileSync(process.execPath, [
    process.env.npm_execpath, "ci",
    "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
  ], {
    cwd: runtime,
    env: { ...process.env, npm_config_local_prefix: runtime },
    stdio: "inherit",
  });

  for (const { client, configFile, schema, server } of targets) {
    const plugin = path.join(root, "plugin-package", client, "smu-fbs-booking");
    const staging = await mkdtemp(path.join(plugin, ".build-"));
    try {
      const nextRuntime = path.join(staging, "runtime");
      const nextConfig = path.join(staging, configFile);
      await cp(runtime, nextRuntime, { recursive: true });
      // The desktop app may start with a different PATH from the user's shell.
      const config = {
        $schema: schema,
        mcpServers: { fbs: { command: process.execPath, ...server } },
      };
      await writeFile(nextConfig, JSON.stringify(config, null, 2) + "\n");

      const currentRuntime = path.join(plugin, "runtime");
      await rm(currentRuntime, { recursive: true, force: true });
      await rename(nextRuntime, currentRuntime);
      await rename(nextConfig, path.join(plugin, configFile));
      console.log("Built " + client + " plugin in " + path.relative(root, plugin));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
} finally {
  await rm(runtime, { recursive: true, force: true });
}
