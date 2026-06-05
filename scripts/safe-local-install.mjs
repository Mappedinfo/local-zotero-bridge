import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const BRIDGE_ADDON_ID = "local-zotero-bridge@mappedinfo.com";
const args = parseArgs(process.argv.slice(2));
const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const profile = args.profile || process.env.ZOTERO_PROFILE_DIR;

if (!profile) {
  fail("Missing Zotero profile. Pass --profile /path/to/profile or set ZOTERO_PROFILE_DIR.");
}

if (!args["allow-running"] && isZoteroRunning()) {
  fail("Zotero appears to be running. Quit Zotero first, then rerun this safe installer.");
}

const xpi = args.xpi || join(root, "release", `local-zotero-bridge-${manifest.version}.xpi`);
await assertFile(xpi, `XPI not found: ${xpi}. Run npm run package first.`);
await assertFile(join(profile, "extensions.json"), `extensions.json not found in profile: ${profile}`);

const before = await readAddonStates(profile);
const beforeByID = new Map(before.map((addon) => [addon.id, addon]));
const targetDir = join(profile, "extensions");
const target = join(targetDir, `${BRIDGE_ADDON_ID}.xpi`);

if (args["dry-run"]) {
  const disabled = before
    .filter((addon) => addon.id !== BRIDGE_ADDON_ID)
    .filter((addon) => addon.userDisabled || addon.appDisabled || addon.softDisabled || addon.active === false);
  console.log(`Dry run: would install ${BRIDGE_ADDON_ID} ${manifest.version} to ${target}`);
  console.log(`Verified readable profile with ${before.length} add-ons; disabled non-bridge add-ons before install: ${disabled.length}.`);
  process.exit(0);
}

await mkdir(targetDir, { recursive: true });

if (existsSync(target)) {
  const backupDir = join(profile, `bridge-extension-backups-${timestamp()}`);
  await mkdir(backupDir, { recursive: true });
  await copyFile(target, join(backupDir, `${BRIDGE_ADDON_ID}.xpi.before-${manifest.version}`));
}

await copyFile(xpi, target);

const after = await readAddonStates(profile);
const changed = [];
for (const addon of after) {
  if (addon.id === BRIDGE_ADDON_ID) continue;
  const previous = beforeByID.get(addon.id);
  if (!previous) continue;
  for (const field of ["active", "userDisabled", "appDisabled", "softDisabled", "embedderDisabled"]) {
    if (previous[field] !== addon[field]) {
      changed.push(`${addon.id}: ${field} ${previous[field]} -> ${addon[field]}`);
    }
  }
}

if (changed.length > 0) {
  fail(`Unsafe Zotero add-on state change detected. The bridge XPI was copied, but non-bridge add-on state changed:\n${changed.join("\n")}`);
}

console.log(`Installed ${BRIDGE_ADDON_ID} ${manifest.version} to ${target}`);
console.log("Verified: no non-bridge Zotero add-on enable/disable state changed.");

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if (key === "allow-running" || key === "dry-run") {
      parsed[key] = true;
    } else {
      parsed[key] = values[index + 1];
      index += 1;
    }
  }
  return parsed;
}

async function readAddonStates(profilePath) {
  const data = JSON.parse(await readFile(join(profilePath, "extensions.json"), "utf8"));
  return (data.addons || []).map((addon) => ({
    id: addon.id,
    active: Boolean(addon.active),
    userDisabled: Boolean(addon.userDisabled),
    appDisabled: Boolean(addon.appDisabled),
    softDisabled: Boolean(addon.softDisabled),
    embedderDisabled: Boolean(addon.embedderDisabled)
  }));
}

async function assertFile(path, message) {
  try {
    const info = await stat(path);
    if (info.isFile()) return;
  } catch {
    // Report the custom message below.
  }
  fail(message);
}

function isZoteroRunning() {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return false;
      const pid = Number(match[1]);
      if (pid === process.pid) return false;
      return basename(match[2]).toLowerCase() === "zotero";
    });
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
