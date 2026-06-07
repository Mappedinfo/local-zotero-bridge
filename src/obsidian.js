(function attachObsidianHelpers(root) {
  const DEFAULT_OBSIDIAN_CONFIG = {
    vaultName: "shiqi-vault-obsidian",
    vaultPath: "/Users/shiqi/Coding/github/wsqstar/shiqi-vault-obsidian",
    targetFolder: "知识库/Zotero同步资料",
    papersFolderName: "Papers",
    indexFileName: ".obsidian-zotero-index.json",
    searchIndexFileName: ".obsidian-zotero-search-index.json",
    pluginStateDirectory: ".obsidian/plugins/local-zotero-mirror",
    internalIndexFileName: "zotero-index.json",
    internalSearchIndexFileName: "zotero-search-index.json",
    filenameTemplate: "{year} - {firstAuthor} - {title}"
  };

  function normalizeVaultPath(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
  }

  function sanitizePathSegment(value) {
    const cleaned = String(value || "")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    return (cleaned || "Untitled").slice(0, 120);
  }

  function buildObsidianOpenUri(config, filePath) {
    const resolved = resolveConfig(config);
    return `obsidian://open?vault=${encodeURIComponent(resolved.vaultName)}&file=${encodeURIComponent(
      normalizeVaultPath(filePath)
    )}`;
  }

  function buildObsidianNewUri(config, item, filePath, now = new Date().toISOString()) {
    const resolved = resolveConfig(config);
    const path = normalizeVaultPath(filePath || buildFallbackPaperPath(config, item));
    const content = buildNewNoteContent(item, now);
    return `obsidian://new?vault=${encodeURIComponent(resolved.vaultName)}&file=${encodeURIComponent(
      path
    )}&content=${encodeURIComponent(content)}`;
  }

  function buildFallbackPaperPath(config, item) {
    const resolved = resolveConfig(config);
    const fileName = `${sanitizePathSegment(renderFilenameTemplate(resolved.filenameTemplate, item))}.md`;
    return normalizeVaultPath([resolved.targetFolder, resolved.papersFolderName, fileName].join("/"));
  }

  function buildObsidianIndexPathCandidates(config) {
    const resolved = resolveConfig(config);
    return [
      joinFsPath(resolved.vaultPath, resolved.pluginStateDirectory, resolved.internalIndexFileName),
      joinFsPath(resolved.vaultPath, resolved.targetFolder, resolved.indexFileName)
    ];
  }

  function buildObsidianSearchIndexPathCandidates(config) {
    const resolved = resolveConfig(config);
    return [
      joinFsPath(resolved.vaultPath, resolved.pluginStateDirectory, resolved.internalSearchIndexFileName),
      joinFsPath(resolved.vaultPath, resolved.targetFolder, resolved.searchIndexFileName)
    ];
  }

  function buildNewNoteContent(item, now = new Date().toISOString()) {
    const title = item.title || "Untitled";
    const lines = [
      "---",
      `zotero_key: ${JSON.stringify(item.key)}`,
      item.citekey ? `citekey: ${JSON.stringify(item.citekey)}` : undefined,
      `title: ${JSON.stringify(title)}`,
      item.zoteroUri ? `zotero_uri: ${JSON.stringify(item.zoteroUri)}` : undefined,
      `last_synced: ${JSON.stringify(now)}`,
      "zotero_deleted: false",
      "---",
      "",
      "<!-- BEGIN OBSIDIAN-ZOTERO-METADATA -->",
      "> [!info] Zotero",
      `> Title: ${title}`,
      `> Key: ${item.key}`,
      item.zoteroUri ? `> Zotero: ${item.zoteroUri}` : undefined,
      "<!-- END OBSIDIAN-ZOTERO-METADATA -->",
      "",
      "## Summary",
      "",
      "## Research Question",
      "",
      "## Method",
      "",
      "## Evidence",
      "",
      "## Useful Ideas",
      "",
      "## Critique",
      "",
      "## Follow-up",
      ""
    ].filter((line) => line !== undefined);
    return lines.join("\n");
  }

  function findIndexItem(index, itemKey) {
    if (!index || !itemKey) return undefined;
    if (index.items && !Array.isArray(index.items)) return index.items[itemKey];
    if (Array.isArray(index.items)) return index.items.find((entry) => entry.itemKey === itemKey);
    return undefined;
  }

  function searchMarkdownNote(markdown, query, limit = 8) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    if (!needle) return [];
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const matches = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toLocaleLowerCase().includes(needle)) continue;
      matches.push({
        line: index + 1,
        text: makeSnippet(line, query)
      });
      if (matches.length >= limit) break;
    }

    return matches;
  }

  function searchLibraryIndex(index, query, limit = 50) {
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];

    const entries = Array.isArray(index?.entries) ? index.entries : [];
    const results = [];

    for (const entry of entries) {
      const fields = {
        title: normalizeSearchText(entry.title),
        citekey: normalizeSearchText(entry.citekey),
        year: normalizeSearchText(entry.year),
        path: normalizeSearchText(entry.path),
        content: normalizeSearchText(entry.content)
      };
      const haystack = [fields.title, fields.citekey, fields.year, fields.path, fields.content].join("\n");
      if (!tokens.every((token) => haystack.includes(token))) continue;

      const matches = searchMarkdownNoteTokens(entry.content || "", tokens, query, 3);
      const score =
        scoreField(fields.title, tokens, 100) +
        scoreField(fields.citekey, tokens, 80) +
        scoreField(fields.year, tokens, 25) +
        scoreField(fields.path, tokens, 15) +
        scoreField(fields.content, tokens, 5) +
        Math.min(matches.length, 3);

      results.push({
        kind: entry.kind,
        path: entry.path,
        title: entry.title || entry.path || "Untitled",
        citekey: entry.citekey,
        year: entry.year,
        itemKey: entry.itemKey,
        noteKey: entry.noteKey,
        zoteroUri: entry.zoteroUri,
        matches,
        score
      });
    }

    return results
      .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)))
      .slice(0, normalizeLimit(limit));
  }

  function renderFilenameTemplate(template, item) {
    const replacements = {
      year: item.year || "n.d.",
      firstAuthor: firstAuthorLastName(item),
      title: item.title || "Untitled",
      citekey: item.citekey || item.key,
      zoteroKey: item.key
    };
    return String(template || DEFAULT_OBSIDIAN_CONFIG.filenameTemplate).replace(
      /\{([A-Za-z0-9_]+)\}/g,
      (_, token) => replacements[token] || ""
    );
  }

  function firstAuthorLastName(item) {
    const creators = Array.isArray(item.creators) ? item.creators : [];
    const creator = creators.find((entry) => entry.creatorType === "author") || creators[0];
    if (!creator) return "Unknown";
    return creator.lastName || creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ") || "Unknown";
  }

  function makeSnippet(line, query) {
    const text = String(line || "").trim().replace(/\s+/g, " ");
    const needle = String(query || "").trim();
    if (!needle || text.length <= 220) return text;
    const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
    if (index === -1) return text.slice(0, 220);
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + needle.length + 120);
    return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
  }

  function searchMarkdownNoteTokens(markdown, tokens, query, limit = 8) {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const matches = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const normalizedLine = normalizeSearchText(line);
      if (!tokens.some((token) => normalizedLine.includes(token))) continue;
      matches.push({
        line: index + 1,
        text: makeSnippet(line, query)
      });
      if (matches.length >= limit) break;
    }

    return matches;
  }

  function tokenizeSearchQuery(query) {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];
    const tokens = normalized.includes(" ") ? normalized.split(/\s+/g).filter(Boolean) : [normalized];
    return [...new Set(tokens)];
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function scoreField(value, tokens, weight) {
    if (!value) return 0;
    return tokens.reduce((score, token) => score + (value.includes(token) ? weight : 0), 0);
  }

  function normalizeLimit(limit) {
    const parsed = Number(limit);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 200) : 50;
  }

  function joinFsPath(...parts) {
    return parts
      .filter(Boolean)
      .join("/")
      .replace(/\/+/g, "/");
  }

  function resolveConfig(config) {
    return {
      ...DEFAULT_OBSIDIAN_CONFIG,
      ...(config || {})
    };
  }

  const api = {
    DEFAULT_OBSIDIAN_CONFIG,
    buildObsidianIndexPathCandidates,
    buildObsidianSearchIndexPathCandidates,
    buildFallbackPaperPath,
    buildNewNoteContent,
    buildObsidianNewUri,
    buildObsidianOpenUri,
    findIndexItem,
    normalizeVaultPath,
    sanitizePathSegment,
    searchLibraryIndex,
    searchMarkdownNote
  };

  root.ObsidianZoteroBridgeObsidian = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
