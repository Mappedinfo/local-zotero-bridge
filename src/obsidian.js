(function attachObsidianHelpers(root) {
  const DEFAULT_OBSIDIAN_CONFIG = {
    vaultName: "shiqi-vault-obsidian",
    vaultPath: "/Users/shiqi/Coding/github/wsqstar/shiqi-vault-obsidian",
    targetFolder: "知识库/Zotero同步资料",
    papersFolderName: "Papers",
    indexFileName: ".obsidian-zotero-index.json",
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

  function resolveConfig(config) {
    return {
      ...DEFAULT_OBSIDIAN_CONFIG,
      ...(config || {})
    };
  }

  const api = {
    DEFAULT_OBSIDIAN_CONFIG,
    buildFallbackPaperPath,
    buildNewNoteContent,
    buildObsidianNewUri,
    buildObsidianOpenUri,
    findIndexItem,
    normalizeVaultPath,
    sanitizePathSegment,
    searchMarkdownNote
  };

  root.ObsidianZoteroBridgeObsidian = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
