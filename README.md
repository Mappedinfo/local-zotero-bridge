# Local Zotero Bridge

Local Zotero Bridge is a Zotero desktop plugin that exposes Zotero collection, item, attachment, and native note metadata to a local Obsidian plugin over Zotero's localhost connector server.

It is designed to work with the companion Obsidian plugin, [Local Zotero Mirror](https://github.com/mappedinfo/local-zotero-mirror).

The plugin also adds Zotero context-menu actions and an `Obsidian Search` section in Zotero's right-side item pane sidenav. That section reads the Obsidian-generated full-text index and opens matching Markdown notes in the configured vault.

## Local Endpoints

- `http://127.0.0.1:23119/obsidian-zotero/status`
- `http://127.0.0.1:23119/obsidian-zotero/snapshot`
- `http://127.0.0.1:23119/obsidian-zotero/citations`
- `http://127.0.0.1:23119/obsidian-zotero/search-obsidian-note`
- `http://127.0.0.1:23119/obsidian-zotero/search-obsidian-library`

## Development

```bash
npm install
npm test
npm run build
npm run package
```

## Distribution

Attach `release/local-zotero-bridge-0.2.14.xpi` to the GitHub release `v0.2.14`, then keep `updates.json` on the default branch so Zotero can check for updates.

Normal users should update through Zotero's add-on manager and this repository's `updates.json` manifest. For local development installs, use the guarded installer instead of editing Zotero profile files by hand:

```bash
npm run safe-install:profile -- --profile "/path/to/Zotero/Profiles/xxxx.default"
```

The safe installer only replaces `local-zotero-bridge@mappedinfo.com.xpi` and verifies that no other Zotero add-on changed its enabled/disabled state. It also supports a read-only check:

```bash
node scripts/safe-local-install.mjs --dry-run --profile "/path/to/Zotero/Profiles/xxxx.default"
```
