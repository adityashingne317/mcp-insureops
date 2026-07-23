#!/usr/bin/env node
/**
 * One-shot setup script: logs into InsureOps and writes/updates this
 * machine's global Cursor MCP config (~/.cursor/mcp.json) so Cursor can
 * talk to the Commission Sync MCP server, no manual JSON editing required.
 *
 * Usage:
 *   node connect-cursor.mjs --server https://<your-hosted-mcp-server>
 *
 * Optional flags:
 *   --email you@company.com     (otherwise prompted)
 *   --password ...              (otherwise prompted, hidden while typing)
 *   --project                   write to ./.cursor/mcp.json instead of the
 *                                global ~/.cursor/mcp.json
 *   --name commission-sync      server key name in mcpServers (default:
 *                                commission-sync)
 *
 * Requires only Node.js (18+) - no npm install needed.
 */

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const BACKEND_LOGIN_URL = "https://devapp.insureops.io/api/v1/auth/login";

function parseArgs(argv) {
  const args = { project: false, name: "commission-sync" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") args.server = argv[++i];
    else if (a === "--email") args.email = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--project") args.project = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
Connect Cursor to Commission Sync

  node connect-cursor.mjs --server https://<your-hosted-mcp-server>

Optional:
  --email you@company.com     InsureOps login email (prompted if omitted)
  --password ...              InsureOps password (prompted, hidden, if omitted)
  --project                   write to ./.cursor/mcp.json (this folder only)
                               instead of ~/.cursor/mcp.json (all of Cursor)
  --name commission-sync      the key name used in mcpServers (default: commission-sync)
`);
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    const onData = (char) => {
      char = char.toString("utf8");
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        process.stdout.write("\n");
        rl.close();
        resolve(value);
        return;
      }
      if (char === "\u0003") process.exit(130); // Ctrl+C
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function login(email, password) {
  const res = await fetch(BACKEND_LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const msg = body?.message ?? `HTTP ${res.status}`;
    throw new Error(`Login failed: ${msg}`);
  }
  const accessToken = body?.data?.accessToken;
  if (!accessToken) throw new Error("Login succeeded but no accessToken was returned.");
  return { accessToken, expiresIn: body?.data?.expiresIn };
}

function loadExistingConfig(path) {
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed.mcpServers) parsed.mcpServers = {};
    return parsed;
  } catch {
    console.warn(`Warning: ${path} exists but isn't valid JSON - it will be backed up and replaced.`);
    writeFileSync(`${path}.bak-${Date.now()}`, readFileSync(path));
    return { mcpServers: {} };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let server = args.server;
  if (!server) {
    server = await prompt("MCP server URL (e.g. https://mcp.yourcompany.com): ");
  }
  server = server.replace(/\/+$/, "").replace(/\/mcp$/, "");
  if (!/^https?:\/\//.test(server)) {
    console.error("Error: server URL must start with http:// or https://");
    process.exit(1);
  }

  const email = args.email ?? (await prompt("InsureOps email: "));
  const password = args.password ?? (await promptHidden("InsureOps password: "));

  console.log("Signing in...");
  const { accessToken, expiresIn } = await login(email, password);
  console.log(`Signed in. Token valid for about ${Math.round((expiresIn ?? 86400) / 3600)} hour(s).`);

  const configPath = args.project
    ? join(process.cwd(), ".cursor", "mcp.json")
    : join(homedir(), ".cursor", "mcp.json");

  mkdirSync(dirname(configPath), { recursive: true });
  const config = loadExistingConfig(configPath);
  config.mcpServers[args.name] = {
    url: `${server}/mcp`,
    headers: { Authorization: `Bearer ${accessToken}` },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\nDone. Wrote "${args.name}" into: ${configPath}`);
  console.log("Restart Cursor (or toggle the server off/on in Settings -> MCP) to connect.");
  console.log("This token expires in about a day - just re-run this script when it does.");
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
