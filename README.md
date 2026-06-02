# Local Zotero Bridge

Local Zotero Bridge is a Zotero desktop plugin that exposes Zotero collection, item, attachment, and native note metadata to a local Obsidian plugin over Zotero's localhost connector server.

It is designed to work with the companion Obsidian plugin, [Local Zotero Mirror](https://github.com/mappedinfo/local-zotero-mirror).

## Local Endpoints

- `http://127.0.0.1:23119/obsidian-zotero/status`
- `http://127.0.0.1:23119/obsidian-zotero/snapshot`
- `http://127.0.0.1:23119/obsidian-zotero/search-obsidian-note`

## Development

```bash
npm install
npm test
npm run build
npm run package
```

## Distribution

Attach `release/local-zotero-bridge-0.2.5.xpi` to the GitHub release `v0.2.5`, then keep `updates.json` on the default branch so Zotero can check for updates.
