import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "src"), { recursive: true });
await mkdir(join(dist, "content", "icons"), { recursive: true });
await mkdir(join(dist, "locale", "en-US"), { recursive: true });
await mkdir(join(dist, "locale", "zh-CN"), { recursive: true });

for (const file of [
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "src/serializer.js",
  "src/obsidian.js",
  "content/icons/local-zotero-bridge.svg",
  "locale/en-US/local-zotero-bridge.ftl",
  "locale/zh-CN/local-zotero-bridge.ftl"
]) {
  const target = join(dist, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, file), target);
}
