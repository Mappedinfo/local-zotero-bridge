import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const release = join(root, "release");
await mkdir(release, { recursive: true });

const output = join(release, `local-zotero-bridge-${manifest.version}.xpi`);
const result = spawnSync("zip", ["-qr", output, "."], {
  cwd: join(root, "dist"),
  stdio: "inherit"
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}
