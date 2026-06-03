# Local Zotero Bridge

Local Zotero Bridge is a Zotero desktop plugin that exposes Zotero collection, item, attachment, and native note metadata to a local Obsidian plugin over Zotero's localhost connector server.

It is designed to work with the companion Obsidian plugin, [Local Zotero Mirror](https://github.com/mappedinfo/local-zotero-mirror).

The plugin also adds Zotero context-menu actions and an `Obsidian` search button beside Zotero's quick search box. That search button reads the Obsidian-generated full-text index and opens matching Markdown notes in the configured vault.

## Local Endpoints

- `http://127.0.0.1:23119/obsidian-zotero/status`
- `http://127.0.0.1:23119/obsidian-zotero/snapshot`
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

Attach `release/local-zotero-bridge-0.2.6.xpi` to the GitHub release `v0.2.6`, then keep `updates.json` on the default branch so Zotero can check for updates.
