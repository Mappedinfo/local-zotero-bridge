(function attachSerializer(root) {
  const SCHEMA_VERSION = 3;

  function creatorName(creator) {
    if (!creator) return "";
    if (typeof creator.name === "string" && creator.name) return creator.name;
    return [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim();
  }

  function getField(entity, field) {
    if (!entity) return undefined;
    if (typeof entity.getField === "function") {
      try {
        return entity.getField(field) || undefined;
      } catch {
        return undefined;
      }
    }
    return entity[field] || entity.data?.[field];
  }

  function getCreators(item) {
    if (typeof item.getCreators === "function") {
      return item.getCreators().map((creator) => ({
        firstName: creator.firstName || undefined,
        lastName: creator.lastName || undefined,
        name: creator.name || creatorName(creator) || undefined,
        creatorType: creator.creatorType || undefined
      }));
    }
    return (item.creators || []).map((creator) => ({
      firstName: creator.firstName || undefined,
      lastName: creator.lastName || undefined,
      name: creator.name || creatorName(creator) || undefined,
      creatorType: creator.creatorType || undefined
    }));
  }

  function getTags(item) {
    if (typeof item.getTags === "function") {
      return item.getTags().map((tag) => (typeof tag === "string" ? tag : tag.tag)).filter(Boolean);
    }
    return (item.tags || []).map((tag) => (typeof tag === "string" ? tag : tag.tag)).filter(Boolean);
  }

  function getCollections(item) {
    if (typeof item.getCollections === "function") {
      return item.getCollections();
    }
    return item.collectionKeys || item.collections || [];
  }

  function getYear(item) {
    const date = getField(item, "date");
    const match = typeof date === "string" ? date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/) : null;
    return match ? match[1] : undefined;
  }

  function getItemType(item) {
    if (typeof item.itemType === "string") return item.itemType;
    if (typeof item.itemTypeID !== "undefined" && root.Zotero?.ItemTypes?.getName) {
      return root.Zotero.ItemTypes.getName(item.itemTypeID);
    }
    return getField(item, "itemType") || "unknown";
  }

  function getLibrary(Zotero, libraryID) {
    const type = Zotero.Libraries?.isGroupLibrary?.(libraryID) ? "group" : "user";
    const library = Zotero.Libraries?.get?.(libraryID);
    return {
      id: libraryID,
      type,
      name: library?.name || library?.libraryType || undefined
    };
  }

  function getZoteroSelectUri(library, key) {
    const prefix = library.type === "group" ? `groups/${library.id}` : "library";
    return `zotero://select/${prefix}/items/${key}`;
  }

  function serializeCollection(collection, collectionByKey) {
    const key = collection.key;
    const parentKey =
      collection.parentKey ||
      collection.parentCollectionKey ||
      (typeof collection.parentKey === "function" ? collection.parentKey() : undefined) ||
      undefined;
    const name = collection.name || getField(collection, "name") || "Untitled Collection";
    const path = buildCollectionPath(collection, collectionByKey);
    const itemKeys =
      (typeof collection.getChildItems === "function" ? collection.getChildItems().map((item) => item.key) : null) ||
      collection.itemKeys ||
      [];

    return {
      key,
      name,
      parentKey,
      path,
      itemKeys,
      version: collection.version || undefined,
      deleted: Boolean(collection.deleted)
    };
  }

  function buildCollectionPath(collection, collectionByKey) {
    const parts = [];
    let cursor = collection;
    const seen = new Set();

    while (cursor && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      parts.unshift(cursor.name || getField(cursor, "name") || "Untitled Collection");
      const parentKey = cursor.parentKey || cursor.parentCollectionKey;
      cursor = parentKey ? collectionByKey.get(parentKey) : null;
    }

    return parts;
  }

  async function serializeAttachment(Zotero, attachment, library) {
    return {
      key: attachment.key,
      title: getField(attachment, "title"),
      fileName: getField(attachment, "filename"),
      mimeType: getField(attachment, "contentType") || attachment.attachmentContentType || undefined,
      zoteroUri: getZoteroSelectUri(library, attachment.key)
    };
  }

  async function getAttachments(Zotero, item, library) {
    let children = [];
    if (typeof item.getAttachments === "function") {
      const attachmentIDs = item.getAttachments();
      children = attachmentIDs.map((id) => Zotero.Items.get(id)).filter(Boolean);
    } else {
      children = item.attachments || [];
    }
    return Promise.all(children.map((attachment) => serializeAttachment(Zotero, attachment, library)));
  }

  async function serializeItem(Zotero, item) {
    const library = getLibrary(Zotero, item.libraryID);
    const attachments = await getAttachments(Zotero, item, library);
    const citekey = getCitationKey(item) || item.key;

    return {
      key: item.key,
      library,
      citekey,
      citation: await buildItemCitationData(Zotero, item, { citekey }),
      title: getField(item, "title") || "Untitled",
      creators: getCreators(item),
      year: getYear(item),
      itemType: getItemType(item),
      publicationTitle: getField(item, "publicationTitle") || getField(item, "proceedingsTitle"),
      doi: getField(item, "DOI") || getField(item, "doi"),
      url: getField(item, "url"),
      collectionKeys: getCollections(item),
      tags: getTags(item),
      zoteroUri: getZoteroSelectUri(library, item.key),
      pdfUri: attachments.find((attachment) => attachment.mimeType === "application/pdf")?.zoteroUri,
      attachments,
      version: item.version || undefined,
      dateModified: getField(item, "dateModified"),
      deleted: Boolean(item.deleted)
    };
  }

  async function serializeNativeNote(Zotero, note) {
    const library = getLibrary(Zotero, note.libraryID);
    const noteHtml = await getNoteHtml(note);

    return {
      key: note.key,
      library,
      parentItemKey: getParentItemKey(Zotero, note),
      title: getNoteTitle(note, noteHtml),
      noteHtml,
      zoteroUri: getZoteroSelectUri(library, note.key),
      version: note.version || undefined,
      dateModified: getField(note, "dateModified"),
      deleted: Boolean(note.deleted)
    };
  }

  function getCitationKey(item) {
    if (typeof item.getField === "function") {
      const extra = item.getField("extra");
      const match = typeof extra === "string" ? extra.match(/Citation Key:\s*(\S+)/i) : null;
      if (match) return match[1];
    }
    return item.citationKey || item.citekey || undefined;
  }

  async function buildItemCitationData(Zotero, item, options = {}) {
    const citekey = options.citekey || getCitationKey(item) || item.key;
    const style = options.style || "apa";
    const quickCitation = await getQuickCopyText(Zotero, [item], style, true);
    const quickReference = await getQuickCopyText(Zotero, [item], style, false);

    return {
      citekey,
      apaInText: quickCitation || fallbackParentheticalCitation([item]),
      apaReference: quickReference || fallbackReference(item),
      bibtex: buildBibtex(item, citekey)
    };
  }

  async function buildCitationResponse(Zotero, options = {}) {
    const style = options.style || "apa";
    const scope = options.scope || "all";
    const groups = parseCitationGroups(options.groups || "");
    const libraryIDs = await getLibraries(Zotero, scope);
    const items = [];

    for (const libraryID of libraryIDs) {
      items.push(...(await getItemsForLibrary(Zotero, libraryID)));
    }

    const itemsByCitekey = new Map();
    for (const item of items) {
      const citekey = getCitationKey(item) || item.key;
      if (citekey && !itemsByCitekey.has(citekey)) {
        itemsByCitekey.set(citekey, item);
      }
      if (item.key && !itemsByCitekey.has(item.key)) {
        itemsByCitekey.set(item.key, item);
      }
    }

    const allRequested = unique(groups.flat());
    const metadataByCitekey = new Map();
    const missingCitekeys = [];

    for (const citekey of allRequested) {
      const item = itemsByCitekey.get(citekey);
      if (!item) {
        missingCitekeys.push(citekey);
        continue;
      }
      const itemCitekey = getCitationKey(item) || item.key;
      const citation = await buildItemCitationData(Zotero, item, { citekey: itemCitekey, style });
      metadataByCitekey.set(citekey, {
        itemKey: item.key,
        citekey: itemCitekey,
        title: getField(item, "title") || "Untitled",
        citation
      });
    }

    const groupResults = [];
    for (const citekeys of groups) {
      const groupItems = citekeys.map((citekey) => itemsByCitekey.get(citekey)).filter(Boolean);
      const missing = citekeys.filter((citekey) => !itemsByCitekey.has(citekey));
      const rendered =
        groupItems.length > 0
          ? withMissingSuffix(
              (await getQuickCopyText(Zotero, groupItems, style, true)) || fallbackParentheticalCitation(groupItems),
              missing
            )
          : fallbackMissingCitation(citekeys);
      groupResults.push({
        citekeys,
        rendered,
        missing,
        items: citekeys.map((citekey) => metadataByCitekey.get(citekey)).filter(Boolean)
      });
    }

    const entries = allRequested.map((citekey) => metadataByCitekey.get(citekey)).filter(Boolean);
    const bibliographyItems = entries.map((entry) => itemsByCitekey.get(entry.citekey) || itemsByCitekey.get(entry.itemKey)).filter(Boolean);
    const quickBibliography = bibliographyItems.length > 0 ? await getQuickCopyText(Zotero, bibliographyItems, style, false) : "";
    const bibliography = quickBibliography
      ? splitBibliographyText(quickBibliography)
      : entries.map((entry) => entry.citation.apaReference).filter(Boolean);

    return {
      ok: true,
      schemaVersion: 1,
      style,
      generatedAt: new Date().toISOString(),
      groups: groupResults,
      bibliography,
      entries,
      missingCitekeys,
      source: "zotero"
    };
  }

  function parseCitationGroups(groups) {
    return String(groups || "")
      .split("|")
      .map((group) =>
        unique(
          group
            .split(",")
            .map((citekey) => citekey.trim())
            .filter(Boolean)
        )
      )
      .filter((group) => group.length > 0);
  }

  async function getQuickCopyText(Zotero, items, style, asCitation) {
    if (!Zotero?.QuickCopy?.getContentFromItems || items.length === 0) return "";
    try {
      const content = await Zotero.QuickCopy.getContentFromItems(items, quickCopyFormat(style), null, asCitation);
      return normalizeQuickCopyContent(content);
    } catch (error) {
      try {
        Zotero.logError?.(error);
      } catch {
        // Logging is best-effort inside fake Zotero test environments.
      }
      return "";
    }
  }

  function quickCopyFormat(style) {
    const styleID = style === "apa" ? "http://www.zotero.org/styles/apa" : style;
    return `bibliography=${styleID}`;
  }

  function normalizeQuickCopyContent(content) {
    if (!content) return "";
    if (typeof content === "string") return cleanWhitespace(content);
    if (typeof content.text === "string" && content.text.trim()) return cleanWhitespace(content.text);
    if (typeof content.html === "string" && content.html.trim()) return cleanWhitespace(plainTextFromHtml(content.html));
    return "";
  }

  function fallbackParentheticalCitation(items) {
    const rendered = items.map((item) => `${creatorLabel(item)}, ${getYear(item) || "n.d."}`).join("; ");
    return `(${rendered || "missing citation"})`;
  }

  function fallbackMissingCitation(citekeys) {
    return `[missing: ${citekeys.join(", ")}]`;
  }

  function withMissingSuffix(rendered, missing) {
    if (!missing.length) return rendered;
    return `${rendered} [missing: ${missing.join(", ")}]`;
  }

  function fallbackReference(item) {
    const creators = getCreators(item).filter((creator) => creator.creatorType === "author" || !creator.creatorType);
    const authorText = creators.length > 0 ? creators.map(formatApaAuthor).join(", ") : creatorLabel(item);
    const year = getYear(item) || "n.d.";
    const title = getField(item, "title") || "Untitled";
    const publication = getField(item, "publicationTitle") || getField(item, "proceedingsTitle");
    const doi = getField(item, "DOI") || getField(item, "doi");
    const url = getField(item, "url");
    const source = doi ? `https://doi.org/${doi}` : url;
    return [authorText ? `${authorText} (${year}).` : `(${year}).`, `${title}.`, publication ? `${publication}.` : "", source || ""]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatApaAuthor(creator) {
    const initials = String(creator.firstName || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `${part[0].toUpperCase()}.`)
      .join(" ");
    const formatted = [creator.lastName, initials].filter(Boolean).join(", ");
    return formatted || creator.name || "Unknown";
  }

  function creatorLabel(item) {
    const creators = getCreators(item).filter((creator) => creator.creatorType === "author" || !creator.creatorType);
    if (creators.length === 0) return titleLabel(item);
    if (creators.length === 1) return creatorLastName(creators[0]);
    if (creators.length === 2) return `${creatorLastName(creators[0])} & ${creatorLastName(creators[1])}`;
    return `${creatorLastName(creators[0])} et al.`;
  }

  function creatorLastName(creator) {
    return creator.lastName || creator.name || creatorName(creator) || "Unknown";
  }

  function titleLabel(item) {
    const title = getField(item, "title") || "Untitled";
    return title.length > 60 ? `${title.slice(0, 57)}...` : title;
  }

  function buildBibtex(item, citekey) {
    const fields = {
      title: getField(item, "title"),
      author: getCreators(item)
        .filter((creator) => creator.creatorType === "author" || !creator.creatorType)
        .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(" and "),
      year: getYear(item),
      journal: getField(item, "publicationTitle"),
      booktitle: getField(item, "proceedingsTitle"),
      doi: getField(item, "DOI") || getField(item, "doi"),
      url: getField(item, "url")
    };
    const type = bibtexType(getItemType(item));
    const body = Object.entries(fields)
      .filter(([, value]) => value)
      .map(([key, value]) => `  ${key} = {${escapeBibtex(String(value))}}`)
      .join(",\n");
    return `@${type}{${citekey}${body ? `,\n${body}\n` : "\n"}}`;
  }

  function bibtexType(itemType) {
    if (itemType === "conferencePaper") return "inproceedings";
    if (itemType === "book") return "book";
    if (itemType === "thesis") return "phdthesis";
    if (itemType === "report") return "techreport";
    return "article";
  }

  function escapeBibtex(value) {
    return value.replace(/[{}]/g, "");
  }

  function splitBibliographyText(text) {
    return String(text || "")
      .split(/\n{2,}|\r?\n(?=\S)/)
      .map((entry) => cleanWhitespace(entry))
      .filter(Boolean);
  }

  function cleanWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function unique(values) {
    return [...new Set(values)];
  }

  async function getLibraries(Zotero, scope) {
    const userLibraryID = Zotero.Libraries?.userLibraryID || Zotero.libraryID;
    const libraries = [];

    if (scope === "all" || scope === "user") {
      libraries.push(userLibraryID);
    }

    if (scope === "all" || scope === "group") {
      const groups = Zotero.Groups?.getAll?.() || [];
      for (const group of groups) {
        if (group.libraryID) libraries.push(group.libraryID);
      }
    }

    return libraries.filter((libraryID) => libraryID !== undefined && libraryID !== null);
  }

  async function getCollectionsForLibrary(Zotero, libraryID) {
    if (Zotero.Collections?.getByLibrary) {
      return Zotero.Collections.getByLibrary(libraryID) || [];
    }
    return [];
  }

  async function getItemsForLibrary(Zotero, libraryID) {
    if (Zotero.Items?.getAll) {
      return (await Zotero.Items.getAll(libraryID)).filter((item) => item && item.isRegularItem?.());
    }
    if (Zotero.Items?.getByLibrary) {
      return (await Zotero.Items.getByLibrary(libraryID)).filter((item) => item && item.isRegularItem?.());
    }
    return [];
  }

  async function getNativeNotesForLibrary(Zotero, libraryID) {
    const allItems = await getAllItemsForLibrary(Zotero, libraryID);
    return allItems.filter((item) => item && isNativeNote(item));
  }

  async function getAllItemsForLibrary(Zotero, libraryID) {
    if (Zotero.Items?.getAll) {
      return Zotero.Items.getAll(libraryID);
    }
    if (Zotero.Items?.getByLibrary) {
      return Zotero.Items.getByLibrary(libraryID);
    }
    return [];
  }

  async function buildSnapshot(Zotero, options = {}) {
    const scope = options.scope || "all";
    const libraryIDs = await getLibraries(Zotero, scope);
    const collections = [];
    const items = [];
    const nativeNotes = [];
    let primaryLibrary = null;

    for (const libraryID of libraryIDs) {
      const library = getLibrary(Zotero, libraryID);
      primaryLibrary = primaryLibrary || library;
      const rawCollections = await getCollectionsForLibrary(Zotero, libraryID);
      const collectionByKey = new Map(rawCollections.map((collection) => [collection.key, collection]));
      collections.push(...rawCollections.map((collection) => serializeCollection(collection, collectionByKey)));

      const rawItems = await getItemsForLibrary(Zotero, libraryID);
      for (const item of rawItems) {
        items.push(await serializeItem(Zotero, item));
      }

      const rawNativeNotes = await getNativeNotesForLibrary(Zotero, libraryID);
      for (const note of rawNativeNotes) {
        nativeNotes.push(await serializeNativeNote(Zotero, note));
      }
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      library: primaryLibrary || { id: "unknown", type: "user" },
      collections,
      items,
      nativeNotes
    };
  }

  function isNativeNote(item) {
    if (typeof item.isNote === "function") {
      return item.isNote();
    }
    return getItemType(item) === "note";
  }

  async function getNoteHtml(note) {
    if (typeof note.getNote === "function") {
      const value = note.getNote();
      return typeof value?.then === "function" ? await value : value || "";
    }
    return getField(note, "note") || note.note || note.noteHtml || "";
  }

  function getNoteTitle(note, noteHtml) {
    if (typeof note.getNoteTitle === "function") {
      try {
        const title = note.getNoteTitle();
        if (title) return title;
      } catch {
        // Fall through to fields.
      }
    }
    return getField(note, "title") || plainTextFromHtml(noteHtml).slice(0, 80) || `Zotero note ${note.key}`;
  }

  function getParentItemKey(Zotero, note) {
    if (typeof note.parentKey === "string" && note.parentKey) return note.parentKey;
    if (typeof note.parentItemKey === "string" && note.parentItemKey) return note.parentItemKey;
    if (note.parentItemID) {
      return Zotero.Items?.get?.(note.parentItemID)?.key || undefined;
    }
    if (note.parentID) {
      return Zotero.Items?.get?.(note.parentID)?.key || undefined;
    }
    return undefined;
  }

  function plainTextFromHtml(html) {
    return String(html || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  const api = {
    buildCitationResponse,
    buildItemCitationData,
    buildSnapshot,
    serializeAttachment,
    serializeCollection,
    serializeItem,
    serializeNativeNote
  };

  root.ObsidianZoteroBridgeSerializer = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
