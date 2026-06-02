import assert from "node:assert/strict";
import test from "node:test";
import "../src/serializer.js";
import "../src/obsidian.js";

const serializer = globalThis.ObsidianZoteroBridgeSerializer;
const obsidian = globalThis.ObsidianZoteroBridgeObsidian;

test("Zotero bridge serializer builds collection and item snapshot", async () => {
  const Zotero = fakeZotero();
  const snapshot = await serializer.buildSnapshot(Zotero, { scope: "user" });

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.collections.length, 2);
  assert.deepEqual(snapshot.collections[1].path, ["Planning", "Scenario Assessment"]);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].citekey, "smithScenario2024");
  assert.equal(snapshot.items[0].attachments[0].mimeType, "application/pdf");
  assert.equal(snapshot.items[0].zoteroUri, "zotero://select/library/items/I1");
  assert.equal(snapshot.nativeNotes.length, 2);
  assert.equal(snapshot.nativeNotes[0].parentItemKey, "I1");
  assert.equal(snapshot.nativeNotes[0].noteHtml, "<p>Child note</p>");
  assert.equal(snapshot.nativeNotes[1].parentItemKey, undefined);
});

test("Obsidian bridge helper builds URIs and searches indexed markdown", () => {
  const item = {
    key: "I1",
    citekey: "smithScenario2024",
    title: "Scenario Paper",
    creators: [{ firstName: "Ada", lastName: "Smith", creatorType: "author" }],
    year: "2024",
    zoteroUri: "zotero://select/library/items/I1"
  };
  const fallbackPath = obsidian.buildFallbackPaperPath(undefined, item);
  assert.equal(fallbackPath, "知识库/Zotero同步资料/Papers/2024 - Smith - Scenario Paper.md");

  const openUri = obsidian.buildObsidianOpenUri(undefined, fallbackPath);
  assert.match(openUri, /^obsidian:\/\/open\?/);
  assert.match(openUri, /vault=shiqi-vault-obsidian/);

  const newUri = obsidian.buildObsidianNewUri(undefined, item, fallbackPath, "2026-06-02T00:00:00.000Z");
  assert.match(decodeURIComponent(newUri), /zotero_key: "I1"/);

  const index = { items: { I1: { itemKey: "I1", path: fallbackPath } } };
  assert.equal(obsidian.findIndexItem(index, "I1").path, fallbackPath);
  assert.deepEqual(obsidian.searchMarkdownNote("alpha\nmethod evidence line\nbeta", "evidence"), [
    { line: 2, text: "method evidence line" }
  ]);
});

function fakeZotero() {
  const collections = [
    {
      key: "C1",
      name: "Planning",
      itemKeys: ["I1"],
      getChildItems: () => [items[0]]
    },
    {
      key: "C2",
      parentKey: "C1",
      name: "Scenario Assessment",
      itemKeys: ["I1"],
      getChildItems: () => [items[0]]
    }
  ];
  const attachment = {
    key: "A1",
    libraryID: 1,
    attachmentContentType: "application/pdf",
    getField: (field: string) =>
      ({
        title: "PDF",
        filename: "paper.pdf",
        contentType: "application/pdf"
      })[field]
  };
  const childNote = {
    key: "N1",
    libraryID: 1,
    itemType: "note",
    version: 3,
    parentItemID: 1,
    isNote: () => true,
    isRegularItem: () => false,
    getNote: () => "<p>Child note</p>",
    getNoteTitle: () => "Child note title",
    getField: (field: string) =>
      ({
        title: "Child note title",
        dateModified: "2026-06-01 12:00:00"
      })[field]
  };
  const standaloneNote = {
    key: "N2",
    libraryID: 1,
    itemType: "note",
    version: 4,
    isNote: () => true,
    isRegularItem: () => false,
    getNote: () => "<p>Standalone note</p>",
    getField: (field: string) =>
      ({
        title: "Standalone note",
        dateModified: "2026-06-01 13:00:00"
      })[field]
  };
  const items = [
    {
      id: 1,
      key: "I1",
      libraryID: 1,
      itemType: "journalArticle",
      version: 9,
      isRegularItem: () => true,
      isNote: () => false,
      getField: (field: string) =>
        ({
          title: "Scenario Paper",
          date: "2024-01-01",
          publicationTitle: "Journal",
          DOI: "10.0000/scenario",
          extra: "Citation Key: smithScenario2024"
        })[field],
      getCreators: () => [{ firstName: "Ada", lastName: "Smith", creatorType: "author" }],
      getTags: () => [{ tag: "planning" }],
      getCollections: () => ["C1", "C2"],
      getAttachments: () => [100]
    },
    childNote,
    standaloneNote
  ];

  return {
    version: "7.0",
    Libraries: {
      userLibraryID: 1,
      isGroupLibrary: () => false,
      get: () => ({ name: "My Library" })
    },
    Collections: {
      getByLibrary: () => collections
    },
    Items: {
      getAll: async () => items,
      get: (id: number) => {
        if (id === 100) return attachment;
        if (id === 1) return items[0];
        return undefined;
      }
    },
    Groups: {
      getAll: () => []
    }
  };
}
