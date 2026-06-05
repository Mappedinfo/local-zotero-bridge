(function attachObsidianNoteBridge(root) {
  const MARKER_NAME = "obsidian-zotero-note";
  const MARKER_RE = /<!--\s*obsidian-zotero-note\s+({[\s\S]*?})\s*-->/i;

  function parseMarker(noteHtml) {
    const match = String(noteHtml || "").match(MARKER_RE);
    if (!match) return null;
    try {
      const marker = JSON.parse(match[1]);
      return marker && marker.source === "obsidian" ? marker : null;
    } catch {
      return null;
    }
  }

  function isObsidianOriginNoteHtml(noteHtml, itemKey) {
    const marker = parseMarker(noteHtml);
    if (!marker) return false;
    return !itemKey || marker.itemKey === itemKey;
  }

  async function getObsidianNote(Zotero, options = {}) {
    const itemKey = cleanString(options.itemKey);
    if (!itemKey) return { ok: false, status: "missing-item", error: "Missing itemKey." };
    const item = await findRegularItemByKey(Zotero, itemKey);
    if (!item) return { ok: false, status: "missing-item", itemKey, error: `No Zotero item found for ${itemKey}.` };
    const found = await findObsidianNoteForItem(Zotero, item, cleanString(options.noteKey));
    if (!found) return { ok: true, status: "missing", itemKey };
    return serializeFoundObsidianNote(found, itemKey);
  }

  async function syncObsidianNote(Zotero, payload = {}) {
    const itemKey = cleanString(payload.itemKey);
    const markdown = normalizeMarkdown(payload.markdown);
    const contentHash = cleanString(payload.contentHash);
    const baseHash = cleanString(payload.baseHash);
    const sourcePath = cleanString(payload.sourcePath);
    const noteKey = cleanString(payload.noteKey);

    if (!itemKey) return { ok: false, status: "missing-item", error: "Missing itemKey." };
    if (!contentHash) return { ok: false, status: "failed", error: "Missing contentHash." };

    const item = await findRegularItemByKey(Zotero, itemKey);
    if (!item) return { ok: false, status: "missing-item", itemKey, error: `No Zotero item found for ${itemKey}.` };

    const citekey = await citekeyForItem(Zotero, item);
    const found = await findObsidianNoteForItem(Zotero, item, noteKey);
    if (found) {
      const remoteHash = cleanString(found.marker?.contentHash);
      const remoteMarkdown = noteHtmlToMarkdown(found.html);
      const actualRemoteHash = hashMarkdownContent(remoteMarkdown);
      if (actualRemoteHash === contentHash) {
        return {
          ok: true,
          status: "unchanged",
          itemKey,
          noteKey: found.note.key,
          zoteroVersion: found.note.version,
          remoteHash: actualRemoteHash
        };
      }
      if ((remoteHash && actualRemoteHash !== remoteHash) || remoteHash !== baseHash) {
        return {
          ok: true,
          status: "conflict",
          itemKey,
          noteKey: found.note.key,
          zoteroVersion: found.note.version,
          remoteHash: actualRemoteHash,
          markerHash: remoteHash,
          remoteMarkdown
        };
      }
      const html = renderObsidianNoteHtml({ itemKey, citekey, sourcePath, markdown, contentHash });
      setNoteHtml(found.note, html);
      await saveItem(found.note);
      return {
        ok: true,
        status: "updated",
        itemKey,
        noteKey: found.note.key,
        zoteroVersion: found.note.version,
        remoteHash: contentHash
      };
    }

    const html = renderObsidianNoteHtml({ itemKey, citekey, sourcePath, markdown, contentHash });
    const note = await createChildNote(Zotero, item, html);
    return {
      ok: true,
      status: "created",
      itemKey,
      noteKey: note.key,
      zoteroVersion: note.version,
      remoteHash: contentHash
    };
  }

  function serializeFoundObsidianNote(found, itemKey) {
    return {
      ok: true,
      status: "found",
      itemKey,
      noteKey: found.note.key,
      zoteroVersion: found.note.version,
      contentHash: found.marker?.contentHash,
      sourcePath: found.marker?.sourcePath,
      markdown: noteHtmlToMarkdown(found.html),
      marker: found.marker
    };
  }

  async function findRegularItemByKey(Zotero, itemKey) {
    const libraryIDs = libraryIDsForZotero(Zotero);
    for (const libraryID of libraryIDs) {
      const direct = getByLibraryAndKey(Zotero, libraryID, itemKey);
      if (direct?.isRegularItem?.()) return direct;
    }
    for (const libraryID of libraryIDs) {
      const items = await getAllItemsForLibrary(Zotero, libraryID);
      const match = items.find((item) => item?.key === itemKey && item.isRegularItem?.());
      if (match) return match;
    }
    return null;
  }

  async function findObsidianNoteForItem(Zotero, item, noteKey) {
    const notes = await getChildNotesForItem(Zotero, item);
    const candidates = noteKey ? notes.filter((note) => note?.key === noteKey) : notes;
    for (const note of candidates) {
      const html = await getNoteHtml(note);
      const marker = parseMarker(html);
      if (marker?.itemKey === item.key) return { note, html, marker };
    }
    if (noteKey) return null;
    return null;
  }

  async function getChildNotesForItem(Zotero, item) {
    if (typeof item.getNotes === "function") {
      const noteIDs = item.getNotes() || [];
      return noteIDs.map((id) => Zotero.Items?.get?.(id)).filter(Boolean);
    }
    return Array.isArray(item.notes) ? item.notes : [];
  }

  async function getAllItemsForLibrary(Zotero, libraryID) {
    if (Zotero.Items?.getAll) return (await Zotero.Items.getAll(libraryID)) || [];
    if (Zotero.Items?.getByLibrary) return (await Zotero.Items.getByLibrary(libraryID)) || [];
    return [];
  }

  function getByLibraryAndKey(Zotero, libraryID, itemKey) {
    try {
      return Zotero.Items?.getByLibraryAndKey?.(libraryID, itemKey) || null;
    } catch {
      return null;
    }
  }

  function libraryIDsForZotero(Zotero) {
    const ids = [];
    const userLibraryID = Zotero.Libraries?.userLibraryID || Zotero.libraryID;
    if (userLibraryID !== undefined && userLibraryID !== null) ids.push(userLibraryID);
    const groups = Zotero.Groups?.getAll?.() || [];
    for (const group of groups) {
      if (group.libraryID !== undefined && group.libraryID !== null) ids.push(group.libraryID);
    }
    return [...new Set(ids)];
  }

  async function citekeyForItem(Zotero, item) {
    try {
      const serialized = await root.ObsidianZoteroBridgeSerializer?.serializeItem?.(Zotero, item);
      if (serialized?.citekey) return serialized.citekey;
    } catch {
      // Fall through to a stable title fallback.
    }
    const extra = getField(item, "extra");
    const match = typeof extra === "string" ? extra.match(/Citation Key:\s*(\S+)/i) : null;
    return match?.[1] || item.citekey || item.citationKey || item.key;
  }

  async function createChildNote(Zotero, item, html) {
    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    note.parentItemID = item.id;
    setNoteHtml(note, html);
    await saveItem(note);
    return note;
  }

  function setNoteHtml(note, html) {
    if (typeof note.setNote === "function") {
      note.setNote(html);
    } else {
      note.noteHtml = html;
      note.note = html;
    }
  }

  async function saveItem(item) {
    if (typeof item.saveTx === "function") return item.saveTx();
    if (typeof item.save === "function") return item.save();
    return item.id;
  }

  async function getNoteHtml(note) {
    if (typeof note.getNote === "function") {
      const value = note.getNote();
      return typeof value?.then === "function" ? await value : value || "";
    }
    return note.noteHtml || note.note || "";
  }

  function renderObsidianNoteHtml({ itemKey, citekey, sourcePath, markdown, contentHash }) {
    const marker = {
      source: "obsidian",
      itemKey,
      sourcePath,
      contentHash,
      schemaVersion: 1,
      updatedAt: new Date().toISOString()
    };
    return [
      `<!-- ${MARKER_NAME} ${JSON.stringify(marker).replace(/--/g, "-")} -->`,
      `<h1>[Obsidian] ${escapeHtml(citekey || itemKey)}</h1>`,
      sourcePath ? `<p><em>Synced from Obsidian: ${escapeHtml(sourcePath)}</em></p>` : "",
      markdownToHtml(markdown)
    ]
      .filter(Boolean)
      .join("\n");
  }

  function markdownToHtml(markdown) {
    const lines = normalizeMarkdown(markdown).split("\n");
    const html = [];
    let paragraph = [];
    let list = [];
    let code = [];
    let inCode = false;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${inlineMarkdownToHtml(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      html.push(`<ul>${list.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join("")}</ul>`);
      list = [];
    };

    for (const line of lines) {
      if (/^```/.test(line)) {
        if (inCode) {
          html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
          code = [];
          inCode = false;
        } else {
          flushParagraph();
          flushList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(line);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        html.push(`<h${heading[1].length}>${inlineMarkdownToHtml(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        list.push(bullet[1]);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      flushList();
      paragraph.push(line.trim());
    }
    if (inCode) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    flushParagraph();
    flushList();
    return html.join("\n");
  }

  function inlineMarkdownToHtml(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  function noteHtmlToMarkdown(html) {
    let text = String(html || "")
      .replace(MARKER_RE, "")
      .replace(/<h1[^>]*>\s*\[Obsidian\][\s\S]*?<\/h1>/i, "")
      .replace(/<p[^>]*>\s*<em>\s*Synced from Obsidian:[\s\S]*?<\/em>\s*<\/p>/i, "")
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_match, code) => `\n\n\`\`\`\n${decodeHtml(code)}\n\`\`\`\n\n`)
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, body) => `\n${"#".repeat(Number(level))} ${stripHtml(body)}\n`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, body) => `\n- ${stripHtml(body)}`)
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    return decodeHtml(text).replace(/\n{3,}/g, "\n\n").trim();
  }

  function stripHtml(value) {
    return decodeHtml(
      String(value || "")
        .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
        .replace(/<a[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
        .replace(/<[^>]+>/g, "")
    ).trim();
  }

  function normalizeMarkdown(value) {
    return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  }

  function hashMarkdownContent(value) {
    const text = canonicalMarkdownForHash(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
  }

  function canonicalMarkdownForHash(value) {
    return normalizeMarkdown(value)
      .split("\n")
      .map((line) => line.replace(/\s+$/g, ""))
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function cleanString(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
  }

  function getField(entity, field) {
    try {
      return typeof entity.getField === "function" ? entity.getField(field) : entity[field] || entity.data?.[field];
    } catch {
      return undefined;
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function decodeHtml(value) {
    return String(value || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }

  const api = {
    MARKER_NAME,
    parseMarker,
    isObsidianOriginNoteHtml,
    getObsidianNote,
    syncObsidianNote,
    renderObsidianNoteHtml,
    noteHtmlToMarkdown,
    markdownToHtml,
    hashMarkdownContent
  };

  root.ObsidianZoteroBridgeObsidianNotes = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
