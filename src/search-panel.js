(function registerLocalZoteroBridgeSearchPanel() {
  const TAG_NAME = "local-zotero-bridge-search-panel";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  if (customElements.get(TAG_NAME)) return;
  if (typeof XULElementBase === "undefined" || typeof MozXULElement === "undefined") {
    throw new Error("Zotero search panel APIs are unavailable");
  }

  class LocalZoteroBridgeSearchPanel extends XULElementBase {
    controller = null;
    debounceTimer = null;
    ready = false;

    get content() {
      return MozXULElement.parseXULToFragment(`
        <html:div
          class="local-zotero-bridge-search-root"
          style="display: flex; flex-direction: column; box-sizing: border-box; min-height: 260px; padding: 8px 12px 12px; color: var(--fill-primary, #222); font: 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif;"
        >
          <hbox
            id="local-zotero-bridge-search-controls"
            align="center"
            style="padding: 8px 0 10px; border-bottom: 1px solid var(--fill-quinary, #e0e0e0);"
          >
            <editable-text
              id="local-zotero-bridge-search-input"
              multiline="false"
              placeholder="搜索 Obsidian 笔记内容..."
              style="flex: 1; min-height: 30px; margin-inline-end: 6px;"
            />
            <button
              id="local-zotero-bridge-search-run"
              label="搜索"
              style="min-height: 30px;"
            />
          </hbox>
          <html:div
            id="local-zotero-bridge-search-status"
            style="margin-top: 8px; min-height: 18px; color: var(--fill-secondary, #666); font-size: 12px;"
          >输入关键词搜索所有同步的 Markdown notes。</html:div>
          <html:div
            id="local-zotero-bridge-search-results"
            style="flex: 1; overflow: auto; padding: 8px 0 4px;"
          ></html:div>
        </html:div>
      `);
    }

    connectedCallback() {
      super.connectedCallback();
      this.bindControls();
    }

    disconnectedCallback() {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      super.disconnectedCallback?.();
    }

    setController(controller) {
      this.controller = controller;
      this.bindControls();
    }

    bindControls() {
      const input = this.input;
      const runButton = this.runButton;
      if (!input || !runButton || input.getAttribute("data-local-zotero-bridge-bound") === "true") {
        this.ready = Boolean(input && runButton && this.status && this.results);
        return;
      }

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.runSearch();
        }
      });
      input.addEventListener("input", () => this.scheduleSearch());
      input.setAttribute("data-local-zotero-bridge-bound", "true");

      runButton.addEventListener("command", () => this.runSearch());
      runButton.setAttribute("data-local-zotero-bridge-bound", "true");
      this.ready = Boolean(this.status && this.results);
    }

    get input() {
      return this.querySelector("#local-zotero-bridge-search-input");
    }

    get runButton() {
      return this.querySelector("#local-zotero-bridge-search-run");
    }

    get status() {
      return this.querySelector("#local-zotero-bridge-search-status");
    }

    get results() {
      return this.querySelector("#local-zotero-bridge-search-results");
    }

    scheduleSearch() {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const query = this.query;
        if (query.length >= 2) {
          this.runSearch();
        } else {
          this.clearResults("输入至少两个字符开始搜索。");
        }
      }, 250);
    }

    async runSearch() {
      const query = this.query;
      if (!query) {
        this.clearResults("输入关键词搜索所有同步的 Markdown notes。");
        return;
      }
      if (!this.controller?.searchObsidianLibrary) {
        this.clearResults("Obsidian search is not ready yet.");
        return;
      }

      this.setStatus("搜索中...");
      try {
        const result = await this.controller.searchObsidianLibrary(query, 50);
        this.renderResults(result);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        this.clearResults(message);
        this.controller?.logError?.(error);
      }
    }

    get query() {
      return String(this.input?.value || "").trim();
    }

    clearResults(message) {
      clearElement(this.results);
      this.setStatus(message);
    }

    setStatus(message) {
      if (this.status) this.status.textContent = message;
    }

    renderResults(result) {
      clearElement(this.results);
      if (!result?.ok) {
        this.setStatus(result?.error || "搜索失败。");
        return;
      }

      this.setStatus(`${result.total} 个结果${result.indexPathUsed ? ` · ${result.indexPathUsed}` : ""}`);
      if (!result.results?.length) {
        const empty = createHTML("div");
        empty.textContent = "没有找到匹配的 Obsidian 笔记。";
        setStyles(empty, { padding: "16px 4px", color: "var(--fill-secondary, #666)" });
        this.results?.appendChild(empty);
        return;
      }

      for (const entry of result.results) {
        this.results?.appendChild(this.renderResultItem(entry));
      }
    }

    renderResultItem(entry) {
      const item = createHTML("div");
      setStyles(item, {
        borderBottom: "1px solid var(--fill-quinary, #e6e6e6)",
        padding: "10px 2px",
        cursor: "pointer"
      });
      item.addEventListener("click", () => this.controller?.openSearchResultInObsidian?.(entry));

      const title = createHTML("div");
      title.textContent = entry.title || entry.path || "Untitled";
      setStyles(title, { fontWeight: "600", marginBottom: "3px" });

      const meta = createHTML("div");
      meta.textContent = [entry.citekey, entry.year, entry.kind].filter(Boolean).join(" · ");
      setStyles(meta, { color: "var(--fill-secondary, #666)", fontSize: "12px", marginBottom: "4px" });

      const path = createHTML("div");
      path.textContent = entry.path || "";
      setStyles(path, {
        color: "var(--fill-secondary, #666)",
        fontSize: "11px",
        marginBottom: "6px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });

      const snippets = createHTML("div");
      const matches = Array.isArray(entry.matches) ? entry.matches.slice(0, 3) : [];
      snippets.textContent = matches.length > 0 ? matches.map((match) => `L${match.line}: ${match.text}`).join("\n") : "";
      setStyles(snippets, {
        whiteSpace: "pre-wrap",
        lineHeight: "1.35",
        marginBottom: entry.itemKey || entry.zoteroUri ? "8px" : "0"
      });

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(path);
      item.appendChild(snippets);

      if (entry.itemKey || entry.zoteroUri) {
        const actions = createHTML("div");
        const openZotero = createHTML("button");
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
          this.controller?.openSearchResultInZotero?.(entry);
        });
        actions.appendChild(openZotero);
        item.appendChild(actions);
      }

      return item;
    }
  }

  customElements.define(TAG_NAME, LocalZoteroBridgeSearchPanel);

  function createHTML(tagName) {
    return document.createElementNS(HTML_NS, tagName);
  }

  function clearElement(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function setStyles(element, styles) {
    if (!element?.style) return;
    for (const [key, value] of Object.entries(styles)) {
      element.style[key] = value;
    }
  }
})();
