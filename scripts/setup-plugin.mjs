import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [client, option] = process.argv.slice(2);
const root = fileURLToPath(new URL("../", import.meta.url));
const pluginId = "smu-fbs-booking@smu-fbs";

if (!["claude", "codex"].includes(client) ||
    (option !== undefined && (client !== "codex" || option !== "--marketplace-only")) ||
    process.argv.length > 4) {
  console.error("Run npm run setup:claude or npm run setup:codex [-- --marketplace-only].");
  process.exit(1);
}

function runClient(args) {
  const options = { cwd: root, stdio: "inherit" };
  // Windows installations can expose the CLI through a .cmd shim.
  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/d", "/c", client, ...args], options);
  } else {
    execFileSync(client, args, options);
  }
}

runClient(["--version"]);
execFileSync(process.execPath, [process.env.npm_execpath, "ci"], { cwd: root, stdio: "inherit" });
// npm ci already runs the prepare script, which compiles the server.
execFileSync(process.execPath, ["scripts/build-plugins.mjs"], { cwd: root, stdio: "inherit" });
runClient(["plugin", "marketplace", "add", "./"]);

if (client === "claude") {
  runClient(["plugin", "install", pluginId, "--scope", "user"]);
} else if (option !== "--marketplace-only") {
  runClient(["plugin", "add", pluginId]);
}
