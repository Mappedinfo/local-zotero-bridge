(function registerLocalZoteroBridgeSearchPanelRenderer() {
  const RENDERER_NAME = "LocalZoteroBridgeSearchPanelRenderer";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const ROOT_ID = "local-zotero-bridge-search-root";
  const INPUT_ID = "local-zotero-bridge-search-input";
  const RUN_ID = "local-zotero-bridge-search-run";
  const STATUS_ID = "local-zotero-bridge-search-status";
  const RESULTS_ID = "local-zotero-bridge-search-results";

  if (window[RENDERER_NAME]) return;

  window[RENDERER_NAME] = {
    render(body, controller) {
      if (!body) throw new Error("Missing Obsidian search panel body");
      const doc = body.ownerDocument || document;
      let root = body.querySelector(`#${ROOT_ID}`);
      if (!root) {
        clearElement(body);
        root = createHTML(doc, "div");
        root.id = ROOT_ID;
        setStyles(root, {
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          minHeight: "260px",
          padding: "8px 12px 12px",
          color: "var(--fill-primary, #222)",
          font: "13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
        });
        body.appendChild(root);
      }

      root.controller = controller;
      if (!root.querySelector(`#${INPUT_ID}`)) {
        renderShell(doc, root);
      }
      bindControls(root, controller);
      root.ready = Boolean(root.querySelector(`#${INPUT_ID}`) && root.querySelector(`#${STATUS_ID}`) && root.querySelector(`#${RESULTS_ID}`));
      return root;
    }
  };

  function renderShell(doc, root) {
    clearElement(root);

    const controls = createHTML(doc, "div");
    setStyles(controls, {
      display: "flex",
      gap: "6px",
      alignItems: "center",
      padding: "8px 0 10px",
      borderBottom: "1px solid var(--fill-quinary, #e0e0e0)"
    });

    const input = createHTML(doc, "input");
    input.id = INPUT_ID;
    input.type = "search";
    input.placeholder = "搜索 Obsidian 笔记内容...";
    setStyles(input, {
      flex: "1",
      width: "100%",
      boxSizing: "border-box",
      padding: "7px 9px",
      border: "1px solid var(--fill-quinary, #c8c8c8)",
      borderRadius: "6px",
      background: "var(--material-background, #fff)",
      color: "inherit",
      font: "inherit",
      minHeight: "30px"
    });

    const runButton = createHTML(doc, "button");
    runButton.id = RUN_ID;
    runButton.type = "button";
    runButton.textContent = "搜索";
    setStyles(runButton, {
      minHeight: "30px",
      padding: "4px 8px",
      border: "1px solid var(--fill-quinary, #c8c8c8)",
      borderRadius: "5px",
      background: "var(--material-background, #fff)",
      color: "inherit",
      cursor: "pointer",
      font: "inherit"
    });

    controls.appendChild(input);
    controls.appendChild(runButton);

    const status = createHTML(doc, "div");
    status.id = STATUS_ID;
    status.textContent = "输入关键词搜索所有同步的 Markdown notes。";
    setStyles(status, {
      marginTop: "8px",
      minHeight: "18px",
      color: "var(--fill-secondary, #666)",
      fontSize: "12px"
    });

    const results = createHTML(doc, "div");
    results.id = RESULTS_ID;
    setStyles(results, {
      flex: "1",
      overflow: "auto",
      padding: "8px 0 4px"
    });

    root.appendChild(controls);
    root.appendChild(status);
    root.appendChild(results);
  }

  function bindControls(root, controller) {
    const input = root.querySelector(`#${INPUT_ID}`);
    const runButton = root.querySelector(`#${RUN_ID}`);
    if (!input || !runButton || input.getAttribute("data-local-zotero-bridge-bound") === "true") return;

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch(root);
      }
    });
    input.addEventListener("input", () => scheduleSearch(root));
    input.setAttribute("data-local-zotero-bridge-bound", "true");

    runButton.addEventListener("click", () => runSearch(root));
    runButton.setAttribute("data-local-zotero-bridge-bound", "true");
    root.controller = controller;
  }

  function scheduleSearch(root) {
    if (root.debounceTimer) clearTimeout(root.debounceTimer);
    root.debounceTimer = setTimeout(() => {
      root.debounceTimer = null;
      const query = getQuery(root);
      if (query.length >= 2) {
        runSearch(root);
      } else {
        clearResults(root, "输入至少两个字符开始搜索。");
      }
    }, 250);
  }

  async function runSearch(root) {
    const query = getQuery(root);
    if (!query) {
      clearResults(root, "输入关键词搜索所有同步的 Markdown notes。");
      return;
    }
    if (!root.controller?.searchObsidianLibrary) {
      clearResults(root, "Obsidian search is not ready yet.");
      return;
    }

    setStatus(root, "搜索中...");
    try {
      const result = await root.controller.searchObsidianLibrary(query, 50);
      renderResults(root, result);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      clearResults(root, message);
      root.controller?.logError?.(error);
    }
  }

  function getQuery(root) {
    return String(root.querySelector(`#${INPUT_ID}`)?.value || "").trim();
  }

  function clearResults(root, message) {
    clearElement(root.querySelector(`#${RESULTS_ID}`));
    setStatus(root, message);
  }

  function setStatus(root, message) {
    const status = root.querySelector(`#${STATUS_ID}`);
    if (status) status.textContent = message;
  }

  function renderResults(root, result) {
    const results = root.querySelector(`#${RESULTS_ID}`);
    clearElement(results);
    if (!result?.ok) {
      setStatus(root, result?.error || "搜索失败。");
      return;
    }

    setStatus(root, `${result.total} 个结果${result.indexPathUsed ? ` · ${result.indexPathUsed}` : ""}`);
    if (!result.results?.length) {
      const empty = createHTML(root.ownerDocument, "div");
      empty.textContent = "没有找到匹配的 Obsidian 笔记。";
      setStyles(empty, { padding: "16px 4px", color: "var(--fill-secondary, #666)" });
      results?.appendChild(empty);
      return;
    }

    for (const entry of result.results) {
      results?.appendChild(renderResultItem(root, entry));
    }
  }

  function renderResultItem(root, entry) {
    const doc = root.ownerDocument;
    const item = createHTML(doc, "div");
    setStyles(item, {
      borderBottom: "1px solid var(--fill-quinary, #e6e6e6)",
      padding: "10px 2px",
      cursor: "pointer"
    });
    item.addEventListener("click", () => root.controller?.openSearchResultInObsidian?.(entry));

    const title = createHTML(doc, "div");
    title.textContent = entry.title || entry.path || "Untitled";
    setStyles(title, { fontWeight: "600", marginBottom: "3px" });

    const meta = createHTML(doc, "div");
    meta.textContent = [entry.citekey, entry.year, entry.kind].filter(Boolean).join(" · ");
    setStyles(meta, { color: "var(--fill-secondary, #666)", fontSize: "12px", marginBottom: "4px" });

    const path = createHTML(doc, "div");
    path.textContent = entry.path || "";
    setStyles(path, {
      color: "var(--fill-secondary, #666)",
      fontSize: "11px",
      marginBottom: "6px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });

    const snippets = createHTML(doc, "div");
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
      const actions = createHTML(doc, "div");
      const openZotero = createHTML(doc, "button");
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
        root.controller?.openSearchResultInZotero?.(entry);
      });
      actions.appendChild(openZotero);
      item.appendChild(actions);
    }

    return item;
  }

  function createHTML(doc, tagName) {
    return doc.createElementNS(HTML_NS, tagName);
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
