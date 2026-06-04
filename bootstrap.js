/* global Services, Zotero, ObsidianZoteroBridgeSerializer */
/* global ObsidianZoteroBridgeObsidian, IOUtils */

const LOCAL_ZOTERO_BRIDGE_PLUGIN_ID = "local-zotero-bridge@mappedinfo.com";
const LOCAL_ZOTERO_BRIDGE_VERSION = "0.2.7";

var ObsidianZoteroBridge = {
  endpoints: [
    "/obsidian-zotero/status",
    "/obsidian-zotero/snapshot",
    "/obsidian-zotero/search-obsidian-note",
    "/obsidian-zotero/search-obsidian-library"
  ],
  menuIDs: [],
  localeInserted: false,
  menuRegistration: {
    ok: false,
    stage: "not-started",
    error: null
  },
  fallbackMenuInstalled: false,
  fallbackMenuError: null,
  fallbackMenuShowingListener: null,
  searchUiInstalled: false,
  searchUiError: null,
  searchPaneID: null,
  searchSectionBody: null,
  searchInput: null,
  searchResultsEl: null,
  searchStatusEl: null,
  searchDebounceTimer: null,
  activeMenuCommand: null,
  lastMenuCommand: null,
  config: {
    vaultName: "shiqi-vault-obsidian",
    vaultPath: "/Users/shiqi/Coding/github/wsqstar/shiqi-vault-obsidian",
    targetFolder: "知识库/Zotero同步资料",
    papersFolderName: "Papers",
    indexFileName: ".obsidian-zotero-index.json",
    searchIndexFileName: ".obsidian-zotero-search-index.json",
    filenameTemplate: "{year} - {firstAuthor} - {title}"
  },

  startup({ rootURI }) {
    this.rootURI = rootURI;
    Services.scriptloader.loadSubScript(`${rootURI}src/serializer.js`);
    Services.scriptloader.loadSubScript(`${rootURI}src/obsidian.js`);
    this.registerEndpoint("/obsidian-zotero/status", async () => ({
      ok: true,
      plugin: "Local Zotero Bridge",
      version: LOCAL_ZOTERO_BRIDGE_VERSION,
      zoteroVersion: Zotero.version,
      schemaVersion: 2,
      menu: {
        managerAvailable: Boolean(Zotero.MenuManager?.registerMenu),
        localeInserted: this.localeInserted,
        registeredMenuIDs: this.menuIDs,
        registration: this.menuRegistration,
        fallbackInstalled: this.fallbackMenuInstalled,
        fallbackError: this.fallbackMenuError,
        activeCommand: this.activeMenuCommand,
        lastCommand: this.lastMenuCommand
      },
      searchUi: {
        installed: this.searchUiInstalled,
        error: this.searchUiError
      },
      generatedAt: new Date().toISOString()
    }));
    this.registerEndpoint("/obsidian-zotero/snapshot", async (request) => {
      const options = {
        scope: getQueryParam(request, "scope") || "all"
      };
      return ObsidianZoteroBridgeSerializer.buildSnapshot(Zotero, options);
    });
    this.registerEndpoint("/obsidian-zotero/search-obsidian-note", async (request) => {
      const itemKey = getQueryParam(request, "itemKey");
      const query = getQueryParam(request, "q") || "";
      return this.searchObsidianNote(itemKey, query);
    });
    this.registerEndpoint("/obsidian-zotero/search-obsidian-library", async (request) => {
      const query = getQueryParam(request, "q") || "";
      const limit = getQueryParam(request, "limit") || "50";
      return this.searchObsidianLibrary(query, limit);
    });
    this.registerMenusWhenReady();
    Zotero.debug("[Local Zotero Bridge] Started");
  },

  shutdown() {
    for (const endpoint of this.endpoints) {
      delete Zotero.Server.Endpoints[endpoint];
    }
    this.unregisterMenus();
    this.uninstallSearchUi();
    Zotero.debug("[Local Zotero Bridge] Stopped");
  },

  registerEndpoint(path, handler) {
    function Endpoint() {}
    Endpoint.prototype.supportedMethods = ["GET"];
    Endpoint.prototype.init = async function init(request) {
      try {
        const payload = await handler(request);
        const body = JSON.stringify(payload);
        return [200, "application/json", body];
      } catch (error) {
        Zotero.logError(error);
        const body = JSON.stringify({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
        return [500, "application/json", body];
      }
    };
    Zotero.Server.Endpoints[path] = Endpoint;
  },

  registerMenusWhenReady() {
    Promise.resolve(Zotero.uiReadyPromise)
      .catch(() => undefined)
      .then(() => {
        this.insertLocale();
        this.installItemMenuFallback();
        this.installSearchUi();
        this.registerMenus();
      })
      .catch((error) => Zotero.logError(error));
  },

  insertLocale() {
    const fileName = "local-zotero-bridge.ftl";
    const win = Zotero.getMainWindow?.();
    const mozXULElement = win?.MozXULElement || globalThis.MozXULElement;

    if (!mozXULElement?.insertFTLIfNeeded) {
      this.menuRegistration = {
        ok: false,
        stage: "locale-unavailable",
        error: "MozXULElement.insertFTLIfNeeded is unavailable"
      };
      Zotero.debug("[Local Zotero Bridge] Cannot insert FTL file; menu labels may be filled by fallback");
      return;
    }

    try {
      mozXULElement.insertFTLIfNeeded(fileName);
      this.localeInserted = true;
    } catch (error) {
      this.menuRegistration = {
        ok: false,
        stage: "locale-error",
        error: error && error.message ? error.message : String(error)
      };
      Zotero.logError(error);
    }
  },

  registerMenus() {
    if (!Zotero.MenuManager?.registerMenu) {
      this.menuRegistration = {
        ok: false,
        stage: "menu-manager-unavailable",
        error: "Zotero.MenuManager.registerMenu is unavailable"
      };
      Zotero.debug("[Local Zotero Bridge] Zotero.MenuManager is unavailable; item menu disabled");
      return;
    }

    const openMenuID = "local-zotero-bridge-open-note";
    const searchMenuID = "local-zotero-bridge-search-note";
    const rootMenuID = "local-zotero-bridge-library-item";
    const selectedItemCondition = (event, context, label) => {
      this.ensureMenuLabel(context?.menuElem, label);
      const hasItem = Boolean(this.getSelectedRegularItem(context)) && !this.fallbackMenuInstalled;
      context?.setVisible?.(hasItem);
      context?.setEnabled?.(hasItem);
    };

    try {
      const registeredID = Zotero.MenuManager.registerMenu({
        menuID: rootMenuID,
        pluginID: LOCAL_ZOTERO_BRIDGE_PLUGIN_ID,
        target: "main/library/item",
        menus: [
          {
            menuID: openMenuID,
            menuType: "menuitem",
            l10nID: "local-zotero-bridge-open-note",
            onShowing: (event, context) => selectedItemCondition(event, context, "在 Obsidian 中打开/添加笔记"),
            onCommand: (event, context) =>
              this.runMenuCommand("open-note", () => this.openSelectedItemInObsidian(context))
          },
          {
            menuID: searchMenuID,
            menuType: "menuitem",
            l10nID: "local-zotero-bridge-search-note",
            onShowing: (event, context) => selectedItemCondition(event, context, "搜索该条目的 Obsidian 笔记..."),
            onCommand: (event, context) =>
              this.runMenuCommand("search-note", () => this.promptSearchSelectedItem(context))
          }
        ]
      });
      this.menuIDs.push(registeredID || rootMenuID);
      this.menuRegistration = {
        ok: true,
        stage: "registered",
        error: null,
        menuIDs: this.menuIDs.slice()
      };
      Zotero.debug("[Local Zotero Bridge] Registered item context menu");
    } catch (error) {
      this.menuRegistration = {
        ok: false,
        stage: "register-error",
        error: error && error.message ? error.message : String(error)
      };
      Zotero.logError(error);
    }
  },

  unregisterMenus() {
    this.uninstallItemMenuFallback();
    if (!Zotero.MenuManager) return;
    for (const menuID of this.menuIDs) {
      try {
        Zotero.MenuManager.unregisterMenu?.(menuID);
      } catch (error) {
        Zotero.logError(error);
      }
    }
    this.menuIDs = [];
  },

  installItemMenuFallback() {
    const win = Zotero.getMainWindow?.();
    const doc = win?.document;
    const menu = doc?.getElementById?.("zotero-itemmenu");
    if (!menu) {
      this.fallbackMenuInstalled = false;
      this.fallbackMenuError = "Cannot find zotero-itemmenu";
      return;
    }

    if (this.fallbackMenuInstalled) return;

    this.fallbackMenuShowingListener = (event) => {
      if (event.target !== event.currentTarget) return;
      win.setTimeout(() => this.updateItemMenuFallback(menu), 0);
    };
    menu.addEventListener("popupshowing", this.fallbackMenuShowingListener);
    this.fallbackMenuInstalled = true;
    this.fallbackMenuError = null;
    this.ensureFallbackMenuElements(menu);
  },

  uninstallItemMenuFallback() {
    const win = Zotero.getMainWindow?.();
    const doc = win?.document;
    const menu = doc?.getElementById?.("zotero-itemmenu");
    if (menu && this.fallbackMenuShowingListener) {
      menu.removeEventListener("popupshowing", this.fallbackMenuShowingListener);
    }

    for (const id of [
      "local-zotero-bridge-itemmenu-separator",
      "local-zotero-bridge-itemmenu-open-note",
      "local-zotero-bridge-itemmenu-search-note"
    ]) {
      try {
        doc?.getElementById?.(id)?.remove();
      } catch (error) {
        Zotero.logError(error);
      }
    }
    this.fallbackMenuShowingListener = null;
    this.fallbackMenuInstalled = false;
  },

  updateItemMenuFallback(menu) {
    try {
      const { separator, openItem, searchItem } = this.ensureFallbackMenuElements(menu);
      const selectedItems = this.getSelectedItemsFromZoteroPane();
      const visible = selectedItems.length > 0;

      separator.hidden = !visible;
      openItem.hidden = !visible;
      searchItem.hidden = !visible;
      openItem.disabled = !visible;
      searchItem.disabled = !visible;
    } catch (error) {
      this.fallbackMenuError = error && error.message ? error.message : String(error);
      Zotero.logError(error);
    }
  },

  ensureFallbackMenuElements(menu) {
    const doc = menu.ownerDocument;
    const createXULElement = (name) =>
      typeof doc.createXULElement === "function" ? doc.createXULElement(name) : doc.createElement(name);

    const separator = this.ensureFallbackMenuElement(
      doc,
      menu,
      "local-zotero-bridge-itemmenu-separator",
      () => createXULElement("menuseparator")
    );
    const openItem = this.ensureFallbackMenuElement(
      doc,
      menu,
      "local-zotero-bridge-itemmenu-open-note",
      () => {
        const item = createXULElement("menuitem");
        item.setAttribute("label", "在 Obsidian 中打开/添加笔记");
        item.addEventListener("command", (event) => {
          event.stopPropagation();
          this.runMenuCommand("open-note", () => this.openItemInObsidian(this.getSelectedRegularItem()));
        });
        return item;
      }
    );
    const searchItem = this.ensureFallbackMenuElement(
      doc,
      menu,
      "local-zotero-bridge-itemmenu-search-note",
      () => {
        const item = createXULElement("menuitem");
        item.setAttribute("label", "搜索该条目的 Obsidian 笔记...");
        item.addEventListener("command", (event) => {
          event.stopPropagation();
          this.runMenuCommand("search-note", () => this.promptSearchItem(this.getSelectedRegularItem()));
        });
        return item;
      }
    );

    return { separator, openItem, searchItem };
  },

  ensureFallbackMenuElement(doc, menu, id, createElement) {
    let element = doc.getElementById(id);
    if (element) return element;
    element = createElement();
    element.id = id;
    element.classList?.add?.("menuitem-iconic");
    element.hidden = true;
    menu.appendChild(element);
    return element;
  },

  ensureMenuLabel(menuElem, label) {
    if (!menuElem || typeof menuElem.setAttribute !== "function") return;
    if (!menuElem.getAttribute?.("label")) {
      menuElem.setAttribute("label", label);
    }
  },

  installSearchUi() {
    if (!Zotero.ItemPaneManager?.registerSection) {
      this.searchUiInstalled = false;
      this.searchUiError = "Zotero.ItemPaneManager.registerSection is unavailable";
      return;
    }
    if (this.searchUiInstalled) return;

    try {
      const icon = `${this.rootURI}content/icons/local-zotero-bridge.svg`;
      const registeredPaneID = Zotero.ItemPaneManager.registerSection({
        paneID: "obsidian-search",
        pluginID: LOCAL_ZOTERO_BRIDGE_PLUGIN_ID,
        header: {
          l10nID: "local-zotero-bridge-search-pane-header",
          icon
        },
        sidenav: {
          l10nID: "local-zotero-bridge-search-pane-sidenav",
          icon,
          orderable: true
        },
        onItemChange: ({ setEnabled, setSectionSummary }) => {
          setEnabled(true);
          setSectionSummary("Search synced Obsidian notes");
        },
        onRender: ({ doc, body, setSectionSummary }) => {
          this.renderSearchSection(doc, body);
          setSectionSummary("Search synced Obsidian notes");
        },
        onDestroy: ({ body }) => {
          if (this.searchSectionBody === body) {
            this.searchSectionBody = null;
            this.searchInput = null;
            this.searchResultsEl = null;
            this.searchStatusEl = null;
          }
        }
      });
      if (!registeredPaneID) {
        throw new Error("Zotero ItemPaneManager did not register the Obsidian search section");
      }
      this.searchPaneID = registeredPaneID;
      this.searchUiInstalled = true;
      this.searchUiError = null;
    } catch (error) {
      this.searchUiInstalled = false;
      this.searchUiError = error && error.message ? error.message : String(error);
      Zotero.logError(error);
    }
  },

  uninstallSearchUi() {
    if (this.searchDebounceTimer) {
      Zotero.getMainWindow?.()?.clearTimeout?.(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    try {
      if (this.searchPaneID) {
        Zotero.ItemPaneManager?.unregisterSection?.(this.searchPaneID);
      }
    } catch (error) {
      Zotero.logError(error);
    }
    this.searchPaneID = null;
    this.searchSectionBody = null;
    this.searchInput = null;
    this.searchResultsEl = null;
    this.searchStatusEl = null;
    this.searchUiInstalled = false;
  },

  renderSearchSection(doc, body) {
    clearElement(body);
    this.searchSectionBody = body;
    setStyles(body, {
      display: "flex",
      flexDirection: "column",
      boxSizing: "border-box",
      minHeight: "260px",
      color: "var(--fill-primary, #222)",
      font: "13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    });

    const controls = doc.createElement("div");
    setStyles(controls, { padding: "8px 0 10px", borderBottom: "1px solid var(--fill-quinary, #e0e0e0)" });

    const input = doc.createElement("input");
    input.type = "search";
    input.placeholder = "搜索 Obsidian 笔记内容...";
    setStyles(input, {
      width: "100%",
      boxSizing: "border-box",
      padding: "7px 9px",
      border: "1px solid var(--fill-quinary, #c8c8c8)",
      borderRadius: "6px",
      font: "inherit"
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.runSearchFromPanel();
      }
    });
    input.addEventListener("input", () => this.scheduleSearchFromPanel());

    const status = doc.createElement("div");
    setStyles(status, {
      marginTop: "8px",
      minHeight: "18px",
      color: "var(--fill-secondary, #666)",
      fontSize: "12px"
    });
    status.textContent = "输入关键词搜索所有同步的 Markdown notes。";
    controls.append(input, status);

    const results = doc.createElement("div");
    setStyles(results, {
      flex: "1",
      overflow: "auto",
      padding: "8px 0 4px"
    });

    body.append(controls, results);
    this.searchInput = input;
    this.searchStatusEl = status;
    this.searchResultsEl = results;
  },

  scheduleSearchFromPanel() {
    const win = Zotero.getMainWindow?.();
    if (!win) return;
    if (this.searchDebounceTimer) {
      win.clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = win.setTimeout(() => {
      this.searchDebounceTimer = null;
      const query = this.searchInput?.value?.trim() || "";
      if (query.length >= 2) {
        this.runSearchFromPanel();
      } else {
        this.clearSearchResults("输入至少两个字符开始搜索。");
      }
    }, 250);
  },

  async runSearchFromPanel() {
    const query = this.searchInput?.value?.trim() || "";
    if (!query) {
      this.clearSearchResults("输入关键词搜索所有同步的 Markdown notes。");
      return;
    }

    this.setSearchStatus("搜索中...");
    try {
      const result = await this.searchObsidianLibrary(query, 50);
      this.renderSearchResults(result);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.clearSearchResults(message);
      Zotero.logError(error);
    }
  },

  clearSearchResults(message) {
    clearElement(this.searchResultsEl);
    this.setSearchStatus(message);
  },

  setSearchStatus(message) {
    if (this.searchStatusEl) {
      this.searchStatusEl.textContent = message;
    }
  },

  renderSearchResults(result) {
    const doc = this.searchResultsEl?.ownerDocument;
    if (!doc || !this.searchResultsEl) return;
    clearElement(this.searchResultsEl);

    if (!result.ok) {
      this.setSearchStatus(result.error || "搜索失败。");
      return;
    }
    this.setSearchStatus(`${result.total} 个结果`);

    if (!result.results.length) {
      const empty = doc.createElement("div");
      empty.textContent = "没有找到匹配的 Obsidian 笔记。";
      setStyles(empty, { padding: "16px 4px", color: "var(--fill-secondary, #666)" });
      this.searchResultsEl.appendChild(empty);
      return;
    }

    for (const entry of result.results) {
      this.searchResultsEl.appendChild(this.renderSearchResultItem(doc, entry));
    }
  },

  renderSearchResultItem(doc, entry) {
    const item = doc.createElement("div");
    setStyles(item, {
      borderBottom: "1px solid var(--fill-quinary, #e6e6e6)",
      padding: "10px 2px",
      cursor: "pointer"
    });
    item.addEventListener("click", () => this.openSearchResultInObsidian(entry));

    const title = doc.createElement("div");
    title.textContent = entry.title || entry.path || "Untitled";
    setStyles(title, { fontWeight: "600", marginBottom: "3px" });

    const meta = doc.createElement("div");
    meta.textContent = [entry.citekey, entry.year, entry.kind].filter(Boolean).join(" · ");
    setStyles(meta, { color: "var(--fill-secondary, #666)", fontSize: "12px", marginBottom: "4px" });

    const path = doc.createElement("div");
    path.textContent = entry.path || "";
    setStyles(path, {
      color: "var(--fill-secondary, #666)",
      fontSize: "11px",
      marginBottom: "6px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });

    const snippets = doc.createElement("div");
    const matches = Array.isArray(entry.matches) ? entry.matches.slice(0, 3) : [];
    snippets.textContent = matches.length > 0 ? matches.map((match) => `L${match.line}: ${match.text}`).join("\n") : "";
    setStyles(snippets, {
      whiteSpace: "pre-wrap",
      lineHeight: "1.35",
      marginBottom: entry.itemKey || entry.zoteroUri ? "8px" : "0"
    });

    item.append(title, meta, path, snippets);

    if (entry.itemKey || entry.zoteroUri) {
      const actions = doc.createElement("div");
      const openZotero = doc.createElement("button");
      openZotero.type = "button";
      openZotero.textContent = "Open Zotero item";
      setStyles(openZotero, {
        padding: "3px 8px",
        border: "1px solid var(--fill-quinary, #c8c8c8)",
        borderRadius: "5px",
        background: "var(--material-background, #fff)",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px"
      });
      openZotero.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openSearchResultInZotero(entry);
      });
      actions.appendChild(openZotero);
      item.appendChild(actions);
    }

    return item;
  },

  openSearchResultInObsidian(entry) {
    if (!entry?.path) return;
    this.launchURL(ObsidianZoteroBridgeObsidian.buildObsidianOpenUri(this.config, entry.path));
  },

  openSearchResultInZotero(entry) {
    if (entry?.zoteroUri) {
      this.launchURL(entry.zoteroUri);
      return;
    }
    if (entry?.itemKey) {
      this.launchURL(`zotero://select/library/items/${entry.itemKey}`);
    }
  },

  runMenuCommand(commandName, task) {
    if (this.activeMenuCommand) return;
    this.activeMenuCommand = commandName;
    this.lastMenuCommand = {
      commandName,
      ok: false,
      stage: "running",
      at: new Date().toISOString()
    };

    Promise.resolve()
      .then(task)
      .then(() => {
        this.lastMenuCommand = {
          commandName,
          ok: true,
          stage: "finished",
          at: new Date().toISOString()
        };
      })
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        this.lastMenuCommand = {
          commandName,
          ok: false,
          stage: "error",
          error: message,
          at: new Date().toISOString()
        };
        Zotero.logError(error);
        this.showError(`Local Zotero Bridge ${commandName} failed: ${message}`);
      })
      .finally(() => {
        this.activeMenuCommand = null;
      });
  },

  showError(message) {
    try {
      Services.prompt.alert(Zotero.getMainWindow?.() || null, "Local Zotero Bridge", message);
    } catch (error) {
      Zotero.logError(error);
    }
  },

  async openSelectedItemInObsidian(context) {
    const item = this.getSelectedRegularItem(context);
    if (!item) throw new Error("No Zotero item is selected.");
    return this.openItemInObsidian(item);
  },

  async openItemInObsidian(item) {
    if (!item) throw new Error("No Zotero item is selected.");
    const serialized = await ObsidianZoteroBridgeSerializer.serializeItem(Zotero, item);
    const index = await this.readObsidianIndex().catch(() => null);
    const entry = ObsidianZoteroBridgeObsidian.findIndexItem(index, serialized.key);
    const uri = entry?.path
      ? ObsidianZoteroBridgeObsidian.buildObsidianOpenUri(this.config, entry.path)
      : ObsidianZoteroBridgeObsidian.buildObsidianNewUri(
          this.config,
          serialized,
          ObsidianZoteroBridgeObsidian.buildFallbackPaperPath(this.config, serialized)
        );
    this.launchURL(uri);
  },

  async promptSearchSelectedItem(context) {
    const item = this.getSelectedRegularItem(context);
    if (!item) throw new Error("No Zotero item is selected.");
    return this.promptSearchItem(item);
  },

  async promptSearchItem(item) {
    if (!item) throw new Error("No Zotero item is selected.");
    const serialized = await ObsidianZoteroBridgeSerializer.serializeItem(Zotero, item);
    const input = { value: "" };
    const ok = Services.prompt.prompt(
      Zotero.getMainWindow?.() || null,
      "搜索 Obsidian 笔记",
      "输入要在该条目对应 Markdown 笔记中搜索的关键词：",
      input,
      null,
      {}
    );
    if (!ok || !input.value.trim()) return;

    const result = await this.searchObsidianNote(serialized.key, input.value.trim());
    const title = "Obsidian 笔记搜索";
    const summary =
      result.matches.length === 0
        ? `没有在对应笔记中找到：${input.value.trim()}`
        : result.matches.map((match) => `L${match.line}: ${match.text}`).join("\n");
    const shouldOpen = Services.prompt.confirm(
      Zotero.getMainWindow?.() || null,
      title,
      `${summary}\n\n打开对应 Obsidian 笔记？`
    );
    if (shouldOpen && result.entry?.path) {
      this.launchURL(ObsidianZoteroBridgeObsidian.buildObsidianOpenUri(this.config, result.entry.path));
    }
  },

  async searchObsidianNote(itemKey, query) {
    if (!itemKey) {
      return { ok: false, error: "Missing itemKey.", matches: [] };
    }
    const index = await this.readObsidianIndex();
    const entry = ObsidianZoteroBridgeObsidian.findIndexItem(index, itemKey);
    if (!entry?.path) {
      return { ok: false, itemKey, error: "No Obsidian note path for item.", matches: [] };
    }
    const absolutePath = joinFsPath(this.config.vaultPath, entry.path);
    const markdown = await readTextFile(absolutePath);
    return {
      ok: true,
      itemKey,
      entry,
      query,
      matches: ObsidianZoteroBridgeObsidian.searchMarkdownNote(markdown, query)
    };
  },

  async searchObsidianLibrary(query, limit = 50) {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) {
      return { ok: true, query: normalizedQuery, total: 0, results: [] };
    }

    let index;
    try {
      index = await this.readObsidianSearchIndex();
    } catch (error) {
      return {
        ok: false,
        query: normalizedQuery,
        total: 0,
        results: [],
        error: "Obsidian search index not found. Run Sync Zotero Library in Obsidian first."
      };
    }

    const results = ObsidianZoteroBridgeObsidian.searchLibraryIndex(index, normalizedQuery, limit);
    return {
      ok: true,
      query: normalizedQuery,
      generatedAt: index.generatedAt,
      schemaVersion: index.schemaVersion,
      total: results.length,
      results
    };
  },

  async readObsidianIndex() {
    const indexPath = joinFsPath(this.config.vaultPath, this.config.targetFolder, this.config.indexFileName);
    const text = await readTextFile(indexPath);
    return JSON.parse(text);
  },

  async readObsidianSearchIndex() {
    const indexPath = joinFsPath(this.config.vaultPath, this.config.targetFolder, this.config.searchIndexFileName);
    const text = await readTextFile(indexPath);
    return JSON.parse(text);
  },

  getSelectedRegularItem(context) {
    const contextItems = Array.isArray(context?.items) ? context.items : [];
    const selectedItems =
      contextItems.length > 0
        ? contextItems
        : this.getSelectedItemsFromZoteroPane();
    if (selectedItems.length !== 1) return null;
    return this.getRegularItemForSelection(selectedItems[0]);
  },

  getSelectedItemsFromZoteroPane() {
    return (
      Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() ||
      Zotero.getMainWindow?.()?.ZoteroPane?.getSelectedItems?.() ||
      []
    );
  },

  getRegularItemForSelection(item) {
    if (!item) return null;
    if (item.isRegularItem?.()) return item;

    const parentItem =
      this.getItemByID(item.parentItemID || item.parentID) ||
      this.getItemByLibraryAndKey(item.libraryID, item.parentItemKey || item.parentKey);
    return parentItem?.isRegularItem?.() ? parentItem : null;
  },

  getItemByID(itemID) {
    if (!itemID) return null;
    try {
      return Zotero.Items?.get?.(itemID) || null;
    } catch (error) {
      Zotero.logError(error);
      return null;
    }
  },

  getItemByLibraryAndKey(libraryID, key) {
    if (!libraryID || !key) return null;
    try {
      return Zotero.Items?.getByLibraryAndKey?.(libraryID, key) || null;
    } catch (error) {
      Zotero.logError(error);
      return null;
    }
  },

  launchURL(uri) {
    if (typeof Zotero.launchURL === "function") {
      Zotero.launchURL(uri);
      return;
    }
    Zotero.getMainWindow?.()?.open(uri);
  }
};

function install() {}

function uninstall() {}

function startup(data) {
  ObsidianZoteroBridge.startup(data);
}

function shutdown() {
  ObsidianZoteroBridge.shutdown();
}

function setStyles(element, styles) {
  if (!element?.style) return;
  for (const [key, value] of Object.entries(styles)) {
    element.style[key] = value;
  }
}

function clearElement(element) {
  if (!element) return;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function getQueryParam(request, key) {
  if (!request) return null;
  if (typeof request === "string") {
    return new URLSearchParams(request.replace(/^\?/, "")).get(key);
  }
  const query = request.query;
  const searchParams = request.searchParams;
  if (searchParams && typeof searchParams.get === "function") {
    return searchParams.get(key);
  }
  if (query && typeof query.get === "function") {
    return query.get(key);
  }
  if (query && typeof query === "object" && key in query) {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  }
  if (typeof query === "string") {
    return new URLSearchParams(query.replace(/^\?/, "")).get(key);
  }
  const data = request.data;
  if (data && typeof data === "object" && key in data) {
    const value = data[key];
    return Array.isArray(value) ? value[0] : value;
  }
  if (typeof data === "string" && data.includes("=")) {
    return new URLSearchParams(data.replace(/^\?/, "")).get(key);
  }
  const url = request.url || request.path || "";
  const queryString = typeof url === "string" && url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return new URLSearchParams(queryString).get(key);
}

function joinFsPath(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
}

async function readTextFile(path) {
  if (typeof IOUtils !== "undefined" && typeof IOUtils.readUTF8 === "function") {
    return IOUtils.readUTF8(path);
  }
  if (Zotero.File?.getContentsAsync) {
    return Zotero.File.getContentsAsync(path);
  }
  throw new Error(`Cannot read file: ${path}`);
}
