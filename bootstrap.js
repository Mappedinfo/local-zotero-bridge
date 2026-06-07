/* global Services, Zotero, ObsidianZoteroBridgeSerializer */
/* global AddonManager, ChromeUtils, Components */
/* global ObsidianZoteroBridgeObsidian, IOUtils */

const LOCAL_ZOTERO_BRIDGE_PLUGIN_ID = "local-zotero-bridge@mappedinfo.com";
const LOCAL_ZOTERO_BRIDGE_VERSION = "0.2.17";
const BETTER_BIBTEX_ADDON_ID = "better-bibtex@iris-advies.com";
const LOCAL_ZOTERO_BRIDGE_SEARCH_PANEL_RENDERER = "LocalZoteroBridgeSearchPanelRenderer";

var ObsidianZoteroBridge = {
  endpoints: [
    "/obsidian-zotero/status",
    "/obsidian-zotero/snapshot",
    "/obsidian-zotero/citations",
    "/obsidian-zotero/obsidian-note",
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
  searchUiRenderError: null,
  searchUiScriptLoaded: false,
  searchPaneID: null,
  searchSectionBody: null,
  searchPanel: null,
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
    pluginStateDirectory: ".obsidian/plugins/local-zotero-mirror",
    internalIndexFileName: "zotero-index.json",
    internalSearchIndexFileName: "zotero-search-index.json",
    filenameTemplate: "{year} - {firstAuthor} - {title}"
  },

  startup({ rootURI }) {
    this.rootURI = rootURI;
    Services.scriptloader.loadSubScript(`${rootURI}src/obsidian-note.js`);
    Services.scriptloader.loadSubScript(`${rootURI}src/serializer.js`);
    Services.scriptloader.loadSubScript(`${rootURI}src/obsidian.js`);
    this.registerEndpoint("/obsidian-zotero/status", async () => {
      const addons = await this.getAddonHealth();
      return {
        ok: true,
        plugin: "Local Zotero Bridge",
        version: LOCAL_ZOTERO_BRIDGE_VERSION,
        zoteroVersion: Zotero.version,
        schemaVersion: 3,
        snapshotCitationMode: "fast",
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
          error: this.searchUiError,
          renderError: this.searchUiRenderError,
          scriptLoaded: this.searchUiScriptLoaded,
          rendererAvailable: this.isSearchPanelRendererAvailable(),
          bodyRendered: Boolean(this.searchPanel?.isConnected && this.searchPanel?.ready)
        },
        indexes: await this.getIndexDiagnostics(),
        addons,
        updateSafety: {
          bridgeAddonID: LOCAL_ZOTERO_BRIDGE_PLUGIN_ID,
          criticalCitationAddonID: BETTER_BIBTEX_ADDON_ID,
          policy: "Bridge updates must only replace the Local Zotero Bridge add-on and must not change userDisabled/appDisabled state for any other Zotero add-on."
        },
        generatedAt: new Date().toISOString()
      };
    });
    this.registerEndpoint("/obsidian-zotero/snapshot", async (request) => {
      const options = {
        scope: getQueryParam(request, "scope") || "all",
        citationMode: snapshotCitationModeForRequest(request)
      };
      return ObsidianZoteroBridgeSerializer.buildSnapshot(Zotero, options);
    });
    this.registerEndpoint("/obsidian-zotero/citations", async (request) => {
      const body = parseRequestBody(request);
      const options = {
        style: requestValue(request, body, "style") || "apa",
        groups: requestValue(request, body, "groups") || "",
        scope: requestValue(request, body, "scope") || "all"
      };
      const response = await ObsidianZoteroBridgeSerializer.buildCitationResponse(Zotero, options);
      return this.withCitationHealthWarnings(response, await this.getAddonHealth());
    });
    this.registerEndpoint("/obsidian-zotero/obsidian-note", async (request) => {
      const body = parseRequestBody(request);
      const isWrite = isPostRequest(request) || Object.prototype.hasOwnProperty.call(body, "markdown");
      if (isWrite) {
        return ObsidianZoteroBridgeObsidianNotes.syncObsidianNote(Zotero, body);
      }
      return ObsidianZoteroBridgeObsidianNotes.getObsidianNote(Zotero, {
        itemKey: requestValue(request, body, "itemKey"),
        noteKey: requestValue(request, body, "noteKey")
      });
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

  onMainWindowLoad(win) {
    if (!this.rootURI) return;
    try {
      this.loadSearchPanelScript(win);
    } catch (error) {
      this.searchUiRenderError = error && error.message ? error.message : String(error);
      Zotero.logError(error);
    }
  },

  onMainWindowUnload(win) {
    if (this.searchPanel?.ownerGlobal === win) {
      this.searchPanel = null;
      this.searchSectionBody = null;
    }
  },

  registerEndpoint(path, handler) {
    function Endpoint() {}
    Endpoint.prototype.supportedMethods = ["GET", "POST"];
    Endpoint.prototype.supportedDataTypes = ["application/json", "application/x-www-form-urlencoded", "text/plain"];
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
      this.loadSearchPanelScriptInMainWindows();
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
        bodyXHTML: this.searchPanelBodyXHTML(),
        onInit: ({ body }) => {
          this.attachSearchPanelController(body);
        },
        onItemChange: ({ setEnabled, setSectionSummary }) => {
          setEnabled(true);
          setSectionSummary("Search synced Obsidian notes");
        },
        onRender: ({ body, setSectionSummary }) => {
          try {
            this.attachSearchPanelController(body);
            setSectionSummary("Search synced Obsidian notes");
            this.searchUiRenderError = null;
          } catch (error) {
            this.searchUiRenderError = error && error.message ? error.message : String(error);
            Zotero.logError(error);
          }
        },
        onDestroy: ({ body }) => {
          if (this.searchSectionBody === body) {
            this.searchSectionBody = null;
            this.searchPanel = null;
          }
        }
      });
      if (!registeredPaneID) {
        throw new Error("Zotero ItemPaneManager did not register the Obsidian search section");
      }
      this.searchPaneID = registeredPaneID;
      this.searchUiInstalled = true;
      this.searchUiError = null;
      this.searchUiRenderError = null;
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
    this.searchPanel = null;
    this.searchUiInstalled = false;
    this.searchUiRenderError = null;
  },

  loadSearchPanelScriptInMainWindows() {
    const windows = Zotero.getMainWindows?.() || [Zotero.getMainWindow?.()].filter(Boolean);
    for (const win of windows) {
      this.loadSearchPanelScript(win);
    }
    if (!windows.length || !this.isSearchPanelRendererAvailable()) {
      throw new Error("Could not load Obsidian search panel renderer in Zotero main window");
    }
  },

  searchPanelBodyXHTML() {
    return `
      <html:div
        id="local-zotero-bridge-search-root"
        style="display: flex; flex-direction: column; box-sizing: border-box; min-height: 260px; padding: 8px 12px 12px; color: var(--fill-primary, #222); font: 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif;"
      >
        <html:div
          style="display: flex; gap: 6px; align-items: center; padding: 8px 0 10px; border-bottom: 1px solid var(--fill-quinary, #e0e0e0);"
        >
          <html:input
            id="local-zotero-bridge-search-input"
            type="search"
            placeholder="搜索 Obsidian 笔记内容..."
            style="flex: 1; width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--fill-quinary, #c8c8c8); border-radius: 6px; background: var(--material-background, #fff); color: inherit; font: inherit; min-height: 30px;"
          ></html:input>
          <html:button
            id="local-zotero-bridge-search-run"
            type="button"
            style="min-height: 30px; padding: 4px 8px; border: 1px solid var(--fill-quinary, #c8c8c8); border-radius: 5px; background: var(--material-background, #fff); color: inherit; cursor: pointer; font: inherit;"
          >搜索</html:button>
        </html:div>
        <html:div
          id="local-zotero-bridge-search-status"
          style="margin-top: 8px; min-height: 18px; color: var(--fill-secondary, #666); font-size: 12px;"
        >输入关键词搜索所有同步的 Markdown notes。</html:div>
        <html:div
          id="local-zotero-bridge-search-results"
          style="flex: 1; overflow: auto; padding: 8px 0 4px;"
        ></html:div>
      </html:div>
    `;
  },

  loadSearchPanelScript(win) {
    if (!win) return;
    if (!win[LOCAL_ZOTERO_BRIDGE_SEARCH_PANEL_RENDERER]) {
      Services.scriptloader.loadSubScript(`${this.rootURI}src/search-panel.js`, win);
    }
    this.searchUiScriptLoaded = this.isSearchPanelRendererAvailable();
  },

  isSearchPanelRendererAvailable() {
    const windows = Zotero.getMainWindows?.() || [Zotero.getMainWindow?.()].filter(Boolean);
    return windows.some((win) => Boolean(win?.[LOCAL_ZOTERO_BRIDGE_SEARCH_PANEL_RENDERER]?.render));
  },

  attachSearchPanelController(body) {
    const win = body.ownerGlobal || body.ownerDocument?.defaultView || Zotero.getMainWindow?.();
    if (!win?.[LOCAL_ZOTERO_BRIDGE_SEARCH_PANEL_RENDERER]?.render) {
      this.loadSearchPanelScript(win);
    }
    const renderer = win?.[LOCAL_ZOTERO_BRIDGE_SEARCH_PANEL_RENDERER];
    if (!renderer?.render) {
      throw new Error("Obsidian search panel renderer was not loaded in this Zotero window");
    }
    const panel = renderer.render(body, this);
    this.searchSectionBody = body;
    this.searchPanel = panel;
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
    const { value: index, path: indexPathUsed } = await this.readObsidianIndexWithMetadata();
    const entry = ObsidianZoteroBridgeObsidian.findIndexItem(index, itemKey);
    if (!entry?.path) {
      return { ok: false, itemKey, indexPathUsed, error: "No Obsidian note path for item.", matches: [] };
    }
    const absolutePath = joinFsPath(this.config.vaultPath, entry.path);
    const markdown = await readTextFile(absolutePath);
    return {
      ok: true,
      itemKey,
      entry,
      query,
      indexPathUsed,
      matches: ObsidianZoteroBridgeObsidian.searchMarkdownNote(markdown, query)
    };
  },

  async searchObsidianLibrary(query, limit = 50) {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) {
      return { ok: true, query: normalizedQuery, total: 0, results: [] };
    }

    let index;
    let indexPathUsed;
    let triedPaths = [];
    try {
      const resolved = await this.readObsidianSearchIndexWithMetadata();
      index = resolved.value;
      indexPathUsed = resolved.path;
      triedPaths = resolved.triedPaths;
    } catch (error) {
      return {
        ok: false,
        query: normalizedQuery,
        total: 0,
        results: [],
        triedPaths: error?.triedPaths || this.obsidianSearchIndexPathCandidates(),
        error: "Obsidian search index not found. Run Sync Zotero Library in Obsidian first."
      };
    }

    const results = ObsidianZoteroBridgeObsidian.searchLibraryIndex(index, normalizedQuery, limit);
    return {
      ok: true,
      query: normalizedQuery,
      generatedAt: index.generatedAt,
      schemaVersion: index.schemaVersion,
      indexPathUsed,
      triedPaths,
      total: results.length,
      results
    };
  },

  async readObsidianIndex() {
    return (await this.readObsidianIndexWithMetadata()).value;
  },

  async readObsidianIndexWithMetadata() {
    return this.readJsonFromPathCandidates(this.obsidianIndexPathCandidates(), "Obsidian Zotero index");
  },

  async readObsidianSearchIndex() {
    return (await this.readObsidianSearchIndexWithMetadata()).value;
  },

  async readObsidianSearchIndexWithMetadata() {
    return this.readJsonFromPathCandidates(this.obsidianSearchIndexPathCandidates(), "Obsidian search index");
  },

  obsidianIndexPathCandidates() {
    return ObsidianZoteroBridgeObsidian.buildObsidianIndexPathCandidates(this.config);
  },

  obsidianSearchIndexPathCandidates() {
    return ObsidianZoteroBridgeObsidian.buildObsidianSearchIndexPathCandidates(this.config);
  },

  async readJsonFromPathCandidates(paths, label) {
    const triedPaths = [];
    let lastError = null;
    for (const path of paths) {
      triedPaths.push(path);
      try {
        const text = await readTextFile(path);
        return { value: JSON.parse(text), path, triedPaths };
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(`${label} not found. Tried: ${triedPaths.join(", ")}`);
    error.triedPaths = triedPaths;
    error.cause = lastError;
    throw error;
  },

  async getIndexDiagnostics() {
    const obsidianIndexPaths = this.obsidianIndexPathCandidates();
    const searchIndexPaths = this.obsidianSearchIndexPathCandidates();
    const obsidianIndex = await this.firstExistingPath(obsidianIndexPaths);
    const searchIndex = await this.firstExistingPath(searchIndexPaths);
    return {
      obsidianIndexPath: obsidianIndex || obsidianIndexPaths[0],
      obsidianIndexExists: Boolean(obsidianIndex),
      obsidianIndexTriedPaths: obsidianIndexPaths,
      searchIndexPath: searchIndex || searchIndexPaths[0],
      searchIndexExists: Boolean(searchIndex),
      searchIndexTriedPaths: searchIndexPaths
    };
  },

  async firstExistingPath(paths) {
    for (const path of paths) {
      if (await fileExists(path)) return path;
    }
    return null;
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

  async getAddonHealth() {
    const health = {
      ok: true,
      inspected: false,
      betterBibTeX: serializeAddonState(null, BETTER_BIBTEX_ADDON_ID),
      disabledAddons: [],
      warnings: []
    };
    const manager = getAddonManager();
    if (!manager) {
      health.ok = false;
      health.warnings.push("Cannot inspect Zotero add-ons; Better BibTeX citekeys may be unavailable if the add-on is disabled.");
      return health;
    }

    health.inspected = true;
    const betterBibtex = await addonManagerGetAddonByID(manager, BETTER_BIBTEX_ADDON_ID);
    health.betterBibTeX = serializeAddonState(betterBibtex, BETTER_BIBTEX_ADDON_ID);

    if (!betterBibtex) {
      health.warnings.push("Better BibTeX is not installed; explicit Citation Key values may be unavailable.");
    } else if (!isAddonEnabled(betterBibtex)) {
      health.warnings.push("Better BibTeX is installed but disabled or inactive; enable it and restart Zotero before syncing citekeys.");
    }

    const allAddons = await addonManagerGetAllAddons(manager);
    health.disabledAddons = allAddons
      .filter((addon) => addon?.type === "extension" && addon.id !== LOCAL_ZOTERO_BRIDGE_PLUGIN_ID && addon.visible !== false)
      .filter((addon) => !isAddonEnabled(addon))
      .map((addon) => serializeAddonState(addon, addon.id));

    if (health.disabledAddons.length > 0) {
      const names = health.disabledAddons.map((addon) => addon.name || addon.id).join(", ");
      health.warnings.push(`Disabled Zotero add-ons detected: ${names}`);
    }

    health.warnings = uniqueStrings(health.warnings);
    health.ok = health.warnings.length === 0;
    return health;
  },

  withCitationHealthWarnings(response, addonHealth) {
    const warnings = Array.isArray(response?.warnings) ? response.warnings.slice() : [];
    if (response?.missingCitekeys?.length > 0 && Array.isArray(addonHealth?.warnings)) {
      warnings.push(...addonHealth.warnings);
    }
    const uniqueWarnings = uniqueStrings(warnings);
    return {
      ...response,
      addons: addonHealth,
      warnings: uniqueWarnings,
      error: response?.error || (uniqueWarnings.length > 0 ? uniqueWarnings.join("; ") : undefined)
    };
  },

  launchURL(uri) {
    if (typeof Zotero.launchURL === "function") {
      Zotero.launchURL(uri);
      return;
    }
    Zotero.getMainWindow?.()?.open(uri);
  }
};

async function addonManagerGetAddonByID(manager, id) {
  try {
    const addon = manager.getAddonByID?.(id);
    return typeof addon?.then === "function" ? await addon : addon || null;
  } catch (error) {
    Zotero.logError?.(error);
    return null;
  }
}

async function addonManagerGetAllAddons(manager) {
  try {
    const addons = manager.getAllAddons?.();
    return (typeof addons?.then === "function" ? await addons : addons) || [];
  } catch (error) {
    Zotero.logError?.(error);
    return [];
  }
}

function getAddonManager() {
  if (typeof AddonManager !== "undefined") return AddonManager;
  if (typeof ChromeUtils !== "undefined") {
    try {
      return ChromeUtils.importESModule?.("resource://gre/modules/AddonManager.sys.mjs")?.AddonManager || null;
    } catch {
      // Fall through to older Zotero/Firefox module paths.
    }
    try {
      return ChromeUtils.import?.("resource://gre/modules/AddonManager.jsm")?.AddonManager || null;
    } catch {
      // Fall through to Components import.
    }
  }
  if (typeof Components !== "undefined") {
    try {
      const target = {};
      Components.utils.import("resource://gre/modules/AddonManager.jsm", target);
      return target.AddonManager || null;
    } catch {
      return null;
    }
  }
  return null;
}

function serializeAddonState(addon, fallbackID) {
  if (!addon) {
    return {
      id: fallbackID,
      installed: false,
      enabled: false,
      active: false,
      userDisabled: null,
      appDisabled: null,
      softDisabled: null,
      state: "missing"
    };
  }
  const active = addon.isActive !== undefined ? Boolean(addon.isActive) : addon.active !== undefined ? Boolean(addon.active) : true;
  const state = isAddonEnabled(addon) ? "available" : "disabled";
  return {
    id: addon.id || fallbackID,
    name: addon.name || addon.defaultLocale?.name,
    version: addon.version,
    installed: true,
    enabled: state === "available",
    active,
    userDisabled: Boolean(addon.userDisabled),
    appDisabled: Boolean(addon.appDisabled),
    softDisabled: Boolean(addon.softDisabled),
    state
  };
}

function isAddonEnabled(addon) {
  if (!addon) return false;
  const active = addon.isActive !== undefined ? Boolean(addon.isActive) : addon.active !== undefined ? Boolean(addon.active) : true;
  return active && !addon.userDisabled && !addon.appDisabled && !addon.softDisabled;
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function install() {}

function uninstall() {}

function startup(data) {
  ObsidianZoteroBridge.startup(data);
}

function shutdown() {
  ObsidianZoteroBridge.shutdown();
}

function onMainWindowLoad({ window }) {
  ObsidianZoteroBridge.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  ObsidianZoteroBridge.onMainWindowUnload(window);
}

function getQueryParam(request, key) {
  const value = queryParamFromSource(request, key);
  return value === undefined ? null : value;
}

function requestValue(request, body, key) {
  if (body && typeof body === "object" && key in body) {
    const value = body[key];
    return Array.isArray(value) ? value[0] : value;
  }
  return getQueryParam(request, key);
}

function snapshotCitationModeForRequest(request) {
  const explicit = String(getQueryParam(request, "citationMode") || getQueryParam(request, "citation_mode") || "").toLowerCase();
  if (explicit === "csl" || explicit === "full") return "csl";
  if (explicit === "fast" || explicit === "metadata") return "fast";

  const includeCsl = String(getQueryParam(request, "includeCsl") || getQueryParam(request, "include_csl") || "").toLowerCase();
  if (includeCsl === "1" || includeCsl === "true" || includeCsl === "yes") return "csl";
  return "fast";
}

function isPostRequest(request) {
  const method = String(request?.method || request?.httpMethod || "").toUpperCase();
  return method === "POST";
}

function parseRequestBody(request) {
  const data = request?.data ?? request?.body;
  if (!data) return {};
  if (typeof data === "object") return data;
  if (typeof data !== "string") return {};
  const trimmed = data.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const params = new URLSearchParams(trimmed.replace(/^\?/, ""));
    return Object.fromEntries(params.entries());
  }
}

function queryParamFromSource(source, key) {
  if (!source) return undefined;
  if (typeof source === "string") return queryParamFromString(source, key);
  const query = source.query;
  const searchParams = source.searchParams;
  if (searchParams && typeof searchParams.get === "function") return searchParams.get(key) ?? undefined;
  if (query && typeof query.get === "function") return query.get(key) ?? undefined;
  if (query && typeof query === "object" && key in query) {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  }
  const fromQuery = queryParamFromString(query, key);
  if (fromQuery !== undefined) return fromQuery;
  const data = source.data ?? source.body;
  if (data && typeof data === "object" && key in data) {
    const value = data[key];
    return Array.isArray(value) ? value[0] : value;
  }
  const fromData = queryParamFromString(data, key);
  if (fromData !== undefined) return fromData;
  return queryParamFromString(source.url || source.path, key);
}

function queryParamFromString(value, key) {
  if (typeof value !== "string") return undefined;
  const queryString = value.includes("?") ? value.slice(value.indexOf("?") + 1) : value;
  if (!queryString.includes("=") && !queryString.startsWith("?")) return undefined;
  const result = new URLSearchParams(queryString.replace(/^\?/, "")).get(key);
  return result === null ? undefined : result;
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

async function fileExists(path) {
  if (typeof IOUtils !== "undefined" && typeof IOUtils.exists === "function") {
    return IOUtils.exists(path);
  }
  try {
    await readTextFile(path);
    return true;
  } catch {
    return false;
  }
}
