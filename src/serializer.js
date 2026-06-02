(function attachSerializer(root) {
  const SCHEMA_VERSION = 2;

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

    return {
      key: item.key,
      library,
      citekey: getCitationKey(item),
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
