<script setup>
import { ref, computed, onMounted, onBeforeUnmount, shallowRef, watch, nextTick } from "vue";
import * as monaco from "monaco-editor";
// Side-effect import: registers Monaco's web workers via MonacoEnvironment.
import "../monaco-env.js";

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
} from "@tauri-apps/plugin-fs";

import TerminalTab from "./TerminalTab.vue";
import FileExplorerTab from "./FileExplorerTab.vue";
import TableTab from "./TableTab.vue";
import WhiteboardTab from "./WhiteboardTab.vue";
import PreviewTab from "./PreviewTab.vue";
import { registerHttpLanguage } from "../http-language.js";
import { findRequestAtCursor } from "../http-parser.js";
import { spellCheckText } from "../spell-check.js";
import { renderMarkdown, renderMermaidIn } from "../markdown-renderer.js";
import {
  getAiConfig,
  saveAiConfig,
  isAiConfigured,
  modelForProvider,
} from "../ai-config.js";
import {
  writeDraft,
  readAllDrafts,
  deleteDraft,
} from "../draft-store.js";
import { checkForUpdate, installAndRelaunch } from "../updater.js";
import { exit as processExit } from "@tauri-apps/plugin-process";
import {
  getSnippets,
  saveSnippet,
  deleteSnippet,
} from "../snippets.js";
import {
  getActions,
  saveAction,
  deleteAction,
} from "../actions.js";

// Lucide icons — imported individually so unused ones get tree-shaken.
import {
  // Toolbar
  FilePlus,
  FolderOpen,
  Save,
  FileDown,
  SquareTerminal,
  FolderTree,
  Sparkles,
  Send,
  SpellCheck,
  Eye,
  EyeOff,
  Sun,
  Moon,
  // Tab kinds (iconFor)
  FileText,
  FileJson,
  Webhook,
  Terminal,
  Folder,
  // Misc UI chrome
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Copy,
  Columns2,
  BookmarkPlus,
  Bookmark,
  Trash2,
  Zap,
  Table2,
  FileSpreadsheet,
  WandSparkles,
  Brush,
  PenTool,
  Image as ImageIcon,
  FileSignature,
  AlertTriangle,
  History,
  Download,
} from "lucide-vue-next";

// One-shot registration of the .http / .rest Monaco language.
registerHttpLanguage();

// Languages we run the CSpell-backed checker against. Code files stay out
// of scope — the dictionary is English prose, so flagging identifiers would
// be all noise.
const SPELL_LANGUAGES = new Set(["markdown", "plaintext"]);

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------
// A tab is either an editor (Monaco) or a terminal (xterm+PTY).
//
// Editor tab fields:
//   id, kind: 'editor', filename, filePath, language, model, viewState, dirty
// Terminal tab fields:
//   id, kind: 'terminal', filename (display name), exited
//
// We store tabs in a `shallowRef` because the values include Monaco/xterm
// objects that mutate themselves; Vue should not deeply observe them.

let nextTabId = 1;
let responseCounter = 1;

// Hand-rolled "tab property change" counter. `tabs` is a shallowRef so
// mutating a property on a tab object (e.g. `tab.language = "markdown"`,
// `tab.dirty = true`) doesn't trigger Vue's reactivity by itself.
// `refreshTabsList()` re-wraps the array, which IS reactive, but every
// downstream computed that does `activeTab.value.language` ends up
// reading the same tab reference — Vue's `hasChanged` comparison fires
// reference equality, sees no change, and skips re-evaluating. The
// preview pane, the "send request" button, etc. silently stop reacting.
//
// Bumping this counter inside refreshTabsList(), and having the
// property-derived computeds dereference it, gives those computeds a
// real reactive dependency that always changes when any tab property
// might have moved. Cheap, predictable, no need to swap object refs.
const tabsVersion = ref(0);

// Stable per-tab id used to name its draft file in $APPLOCALDATA/drafts/.
// Survives Save As (tab keeps the same draftKey) and tab activations.
function nextDraftKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
const tabs = shallowRef([]);
const activeTabId = ref(null);

// Spell-check state. The worker is shared across tabs; per-tab debounce
// timers prevent flooding it as the user types.
const spellCheckEnabled = ref(true);
const spellTimers = new Map(); // tabId -> setTimeout handle

// Markdown preview state. Only the active markdown tab is ever rendered —
// previews for background tabs aren't visible, so there's no point keeping
// them up to date.
const showPreview = ref(true);
const previewHtml = ref("");
const previewPaneEl = ref(null); // DOM node — for post-render mermaid pass
let previewTimer = null;

// ---------------------------------------------------------------------------
// Split view (two editor panels side-by-side)
// ---------------------------------------------------------------------------
//
// When `splitView` flips on, we mount a second Monaco editor on the right
// half of the content area and let the user pick which editor tab to view
// there. The same model can be shown in both editors at once (Monaco
// handles that — edits in either side propagate to the other), or two
// different tabs can be compared side-by-side.
//
// Terminals and explorers still render fullbleed over the content area
// when they're the *left* panel's active tab, on the theory that
// "you opened a terminal" overrides whatever else is on screen.

const splitView = ref(false);
const rightPanelTabId = ref(null);
const editor2Container = ref(null);
let editor2 = null;
// Per-tab view state for the right editor — kept separate from the left
// editor's `tab.viewState` so each side remembers its own cursor/scroll.
const editor2ViewStates = new Map();

// Monaco instance shared across editor tabs.
const editorContainer = ref(null);
let editor = null;

const STARTER_SAMPLES = {
  javascript: `// Welcome to Sparrow's editor
function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("Tauri"));
`,
  typescript: `// TypeScript example
interface User { name: string; age: number; }
function greet(u: User): string { return \`Hello, \${u.name}\`; }
`,
  json: `{
  "app": "sparrow",
  "version": "0.1.0",
  "features": ["tabs", "monaco", "terminal"]
}
`,
  html: `<!doctype html>\n<html><body><h1>Hello</h1></body></html>\n`,
  css: `body { font-family: system-ui; }\n`,
  python: `def greet(name):\n    return f"Hello, {name}"\n`,
  markdown: `# Sparrow

A *fast*, **multi-tab** code editor inside Tauri.

## Features

- Monaco editor with multi-tab support
- Native **File** and **Tools** menus
- PTY-backed [xterm.js](https://xtermjs.org) terminals
- \`.http\` REST client with response viewer
- CSpell-powered spell check for markdown & plaintext
- **Live markdown preview** (you're looking at it)

## Try it

This tab uses **CSpell** to highlight possible mispellings as you type.
Try writing some incorect words and watch the squiggles appear in the editor.

> Tip: toggle the *Preview* button in the toolbar to hide this pane.

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

### Today

- [x] Implement multi-tab UI
- [x] Add markdown preview
- [ ] Ship v1
- [ ] Tell people about it

| Feature | Shortcut |
| ------- | -------- |
| New tab | Cmd/Ctrl+N |
| Save    | Cmd/Ctrl+S |
| Terminal | Cmd/Ctrl+T |
`,
  http: `### Get a JSON sample
GET https://httpbin.org/json

### Echo your IP
@host = https://httpbin.org

GET {{host}}/ip
Accept: application/json

### Post some JSON
POST {{host}}/post
Content-Type: application/json

{
  "name": "Sparrow",
  "kind": "Tauri app"
}
`,
  plaintext: ``,
};

function languageFromFilename(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    md: "markdown", markdown: "markdown",
    py: "python", rs: "rust", go: "go", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp",
    cs: "csharp", rb: "ruby", php: "php",
    sh: "shell", bash: "shell",
    yml: "yaml", yaml: "yaml",
    toml: "ini", xml: "xml", sql: "sql", vue: "html",
    http: "http", rest: "http",
  };
  return map[ext] || "plaintext";
}

function basename(path) {
  if (!path) return "";
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(idx + 1);
}

function refreshTabsList() {
  tabs.value = [...tabs.value];
  // Force property-derived computeds (isMarkdownActive, canSendRequest,
  // isEditorActive when language changes, etc.) to re-evaluate.
  tabsVersion.value++;
}

// ---------------------------------------------------------------------------
// Editor-tab factory
// ---------------------------------------------------------------------------

function makeEditorTab({ filename, language, value, filePath = null, readOnly = false }) {
  const id = nextTabId++;
  const lang = language || languageFromFilename(filename);
  const initial = value !== undefined ? value : STARTER_SAMPLES[lang] ?? "";
  const model = monaco.editor.createModel(initial, lang);
  const tab = {
    id,
    kind: "editor",
    filename,
    filePath,
    language: lang,
    model,
    viewState: null,
    dirty: false,
    readOnly,
    draftKey: nextDraftKey(),
  };
  model.onDidChangeContent(() => {
    if (!tab.dirty) {
      tab.dirty = true;
      refreshTabsList();
    }
    scheduleSpellCheck(tab);
    schedulePreviewUpdate(tab);
    scheduleDraftSave(tab);
  });
  // Initial pass so a freshly-opened markdown/plaintext tab gets squiggles
  // before the user has typed anything.
  scheduleSpellCheck(tab);
  return tab;
}

function makeTerminalTab({ filename, initialCommand } = {}) {
  const id = nextTabId++;
  // Number the terminals among themselves for friendly labels.
  const termCount =
    tabs.value.filter((t) => t.kind === "terminal").length + 1;
  return {
    id,
    kind: "terminal",
    filename: filename || `Terminal ${termCount}`,
    initialCommand: initialCommand || "",
    exited: false,
  };
}

// Tabulator-backed CSV / XLSX tab. The raw bytes / text are baked into the
// tab object once at open time; the TableTab component owns the live grid
// state from there and we use a per-tab ref to read it back at save time.
function makeTableTab({ filename, filePath, format, rawText, rawBytes }) {
  const id = nextTabId++;
  return {
    id,
    kind: "table",
    filename,
    filePath: filePath || null,
    format, // "csv" | "xlsx"
    rawText: rawText || "",
    rawBytes: rawBytes || null,
    dirty: false,
    draftKey: nextDraftKey(),
  };
}

// Map of tab.id → TableTab component instance. Populated by the function
// ref in the template; cleaned up automatically when tabs close.
const tableRefs = {};

// Fabric-backed whiteboard tab. `boardJson` carries the persisted board
// (Fabric's toJSON() output) at open time; the WhiteboardTab component
// owns the live canvas state from there.
function makeWhiteboardTab({ filename, filePath, boardJson }) {
  const id = nextTabId++;
  return {
    id,
    kind: "whiteboard",
    filename,
    filePath: filePath || null,
    boardJson: boardJson || null,
    dirty: false,
    draftKey: nextDraftKey(),
  };
}

// Per-tab handle to the WhiteboardTab component, mirroring `tableRefs`.
const whiteboardRefs = {};

// Read-only preview tab for images / SVG / PDF. The raw bytes are stashed
// on the tab; the PreviewTab component wraps them in a Blob and serves an
// object URL to <img> or <iframe>.
function makePreviewTab({ filename, filePath, format, rawBytes }) {
  const id = nextTabId++;
  return {
    id,
    kind: "preview",
    filename,
    filePath: filePath || null,
    format, // png | jpg | jpeg | gif | webp | bmp | ico | svg | tiff | pdf
    rawBytes: rawBytes || null,
    dirty: false,
  };
}

function makeExplorerTab(folderPath) {
  const id = nextTabId++;
  // Display the folder's leaf name with a trailing slash so it's obviously
  // a directory in the tab strip. Fall back to the raw path if we can't
  // extract a leaf (e.g. drive roots like "C:\\").
  const leaf =
    folderPath
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || folderPath;
  return {
    id,
    kind: "explorer",
    filename: `${leaf}/`,
    folderPath,
  };
}

// ---------------------------------------------------------------------------
// Active-tab plumbing
// ---------------------------------------------------------------------------

const activeTab = computed(
  () => tabs.value.find((t) => t.id === activeTabId.value) || null
);
const isEditorActive = computed(() => {
  // Touch the version so refreshTabsList() invalidates this even when
  // the tab reference is unchanged (e.g. tab.kind never changes, but we
  // keep the dep here for symmetry with the other property-derived
  // computeds — cheap and predictable).
  tabsVersion.value;
  return activeTab.value?.kind === "editor";
});

const isMarkdownActive = computed(() => {
  // This is the one that bites without `tabsVersion`: changing the tab's
  // language via the status-bar dropdown mutates `tab.language` in place,
  // but the active-tab computed returns the same object reference, so
  // Vue would otherwise consider this computed's value unchanged.
  tabsVersion.value;
  return (
    activeTab.value?.kind === "editor" &&
    activeTab.value?.language === "markdown"
  );
});
// The preview pane only shows when:
//   - the active tab is markdown, AND
//   - the user hasn't toggled the preview off, AND
//   - split view isn't on (split takes the right half).
const showPreviewActive = computed(
  () => isMarkdownActive.value && showPreview.value && !splitView.value
);

// Filtered list used by the right panel's selector (editor tabs only —
// terminals/explorers don't belong in a Monaco pane).
const editorTabs = computed(() =>
  tabs.value.filter((t) => t.kind === "editor")
);

// Terminal tabs are rendered in a v-for; they need stable keys. We pre-compute
// the list here for clarity (not strictly necessary).
const terminalTabs = computed(() =>
  tabs.value.filter((t) => t.kind === "terminal")
);
const explorerTabs = computed(() =>
  tabs.value.filter((t) => t.kind === "explorer")
);
const tableTabsList = computed(() =>
  tabs.value.filter((t) => t.kind === "table")
);
const whiteboardTabsList = computed(() =>
  tabs.value.filter((t) => t.kind === "whiteboard")
);
const previewTabsList = computed(() =>
  tabs.value.filter((t) => t.kind === "preview")
);

function activateTab(tabId) {
  if (activeTabId.value === tabId) return;

  // If leaving an editor tab, snapshot its view state before swapping.
  const previous = tabs.value.find((t) => t.id === activeTabId.value);
  if (previous && previous.kind === "editor" && editor) {
    previous.viewState = editor.saveViewState();
  }

  const next = tabs.value.find((t) => t.id === tabId);
  if (!next) return;

  activeTabId.value = tabId;

  if (next.kind === "editor" && editor) {
    editor.setModel(next.model);
    if (next.viewState) editor.restoreViewState(next.viewState);
    editor.updateOptions({ readOnly: !!next.readOnly });
    // Layout immediately — host may have just become visible.
    requestAnimationFrame(() => editor.layout());
    editor.focus();
    // Refresh the preview to reflect the newly-active model's contents.
    if (next.language === "markdown") {
      updatePreviewNow();
    }
  }
  // Terminal tabs handle their own focus via the `active` prop watcher.
}

function defaultUntitledName() {
  let i = tabs.value.filter((t) => t.kind === "editor").length + 1;
  let name;
  do {
    name = `untitled-${i}.js`;
    i++;
  } while (tabs.value.some((t) => t.filename === name));
  return name;
}

function addEditorTab(filename) {
  const tab = makeEditorTab({ filename: filename || defaultUntitledName() });
  tabs.value = [...tabs.value, tab];
  activateTab(tab.id);
  return tab;
}

function addTerminalTab() {
  const tab = makeTerminalTab();
  tabs.value = [...tabs.value, tab];
  activateTab(tab.id);
  flashStatus(`Opened ${tab.filename}`);
  return tab;
}

function closeTab(tabId, event) {
  if (event) event.stopPropagation();
  const idx = tabs.value.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const tab = tabs.value[idx];

  if (tab.kind === "editor" && tab.dirty) {
    const ok = window.confirm(
      `"${tab.filename}" has unsaved changes. Close anyway?`
    );
    if (!ok) return;
  }
  if (tab.kind === "table") {
    // Free the function-ref entry so we don't leak the component instance.
    delete tableRefs[tab.id];
  }
  if (tab.kind === "whiteboard") {
    delete whiteboardRefs[tab.id];
  }

  // Drop any pending autosave for this tab and remove its draft on disk —
  // closing a tab is the user's signal that they don't need recovery for it.
  const pendingDraft = draftTimers.get(tab.id);
  if (pendingDraft) {
    clearTimeout(pendingDraft);
    draftTimers.delete(tab.id);
  }
  if (tab.draftKey) {
    deleteDraft(tab.draftKey).catch(() => {});
  }

  if (tab.kind === "editor") {
    // Drop any pending spell-check timer so it doesn't fire on a disposed model.
    const pending = spellTimers.get(tab.id);
    if (pending) {
      clearTimeout(pending);
      spellTimers.delete(tab.id);
    }
    // If the right pane was showing this tab, clear it so the disposed
    // model doesn't try to render.
    if (rightPanelTabId.value === tab.id) {
      rightPanelTabId.value = null;
      if (editor2) editor2.setModel(null);
    }
    editor2ViewStates.delete(tab.id);
    tab.model.dispose();
  }
  // For terminal tabs: the TerminalTab component's onBeforeUnmount handles
  // PTY cleanup automatically when v-for removes its DOM node.

  const next = tabs.value.filter((t) => t.id !== tabId);
  tabs.value = next;

  if (activeTabId.value === tabId) {
    if (next.length === 0) {
      activeTabId.value = null;
      if (editor) editor.setModel(null);
    } else {
      const neighbor = next[Math.max(0, idx - 1)];
      activeTabId.value = null; // force activateTab to do real work
      activateTab(neighbor.id);
    }
  }
}

function renameTab(tab) {
  if (tab.kind !== "editor") {
    // Terminals get a simple inline rename — useful for "build", "logs", etc.
    const newName = window.prompt("Rename terminal:", tab.filename);
    if (!newName || newName === tab.filename) return;
    tab.filename = newName;
    refreshTabsList();
    return;
  }
  const newName = window.prompt("Rename tab:", tab.filename);
  if (!newName || newName === tab.filename) return;
  tab.filename = newName;
  const newLang = languageFromFilename(newName);
  if (newLang !== tab.language) {
    monaco.editor.setModelLanguage(tab.model, newLang);
    tab.language = newLang;
    // Language change can flip spell-check applicability either way.
    clearSpellMarkers(tab);
    scheduleSpellCheck(tab);
  }
  refreshTabsList();
}

function onTerminalExit(tabId) {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (!tab) return;
  tab.exited = true;
  refreshTabsList();
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

const statusMsg = ref("");
function flashStatus(text, ms = 2200) {
  statusMsg.value = text;
  setTimeout(() => {
    if (statusMsg.value === text) statusMsg.value = "";
  }, ms);
}

function handleNew() {
  addEditorTab();
  flashStatus("New tab");
}

async function handleSave() {
  const tab = activeTab.value;
  if (!tab) {
    flashStatus("Save: no active tab");
    return;
  }
  if (tab.kind === "table") return saveTableTab(tab);
  if (tab.kind === "whiteboard") return saveWhiteboardTab(tab);
  if (tab.kind !== "editor") {
    flashStatus("This kind of tab can't be saved");
    return;
  }
  if (!tab.filePath) return handleSaveAs();
  try {
    await writeTextFile(tab.filePath, tab.model.getValue());
    tab.dirty = false;
    refreshTabsList();
    clearDraftForTab(tab);
    flashStatus(`Saved ${tab.filename}`);
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
}

async function handleSaveAs() {
  const tab = activeTab.value;
  if (!tab) {
    flashStatus("Save As: no active tab");
    return;
  }
  if (tab.kind === "table") return saveTableTabAs(tab);
  if (tab.kind === "whiteboard") return saveWhiteboardTabAs(tab);
  if (tab.kind !== "editor") {
    flashStatus("This kind of tab can't be saved");
    return;
  }
  try {
    const chosen = await saveDialog({
      title: "Save As",
      defaultPath: tab.filePath || tab.filename,
    });
    if (!chosen) return;
    await writeTextFile(chosen, tab.model.getValue());
    tab.filePath = chosen;
    tab.filename = basename(chosen);
    const newLang = languageFromFilename(tab.filename);
    if (newLang !== tab.language) {
      monaco.editor.setModelLanguage(tab.model, newLang);
      tab.language = newLang;
    }
    tab.dirty = false;
    refreshTabsList();
    clearDraftForTab(tab);
    flashStatus(`Saved ${tab.filename}`);
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
}

// --- Table tab save helpers -----------------------------------------------

async function saveTableTab(tab) {
  if (!tab.filePath) return saveTableTabAs(tab);
  const ref = tableRefs[tab.id];
  if (!ref) {
    flashStatus("Table not ready yet — try again in a moment");
    return;
  }
  try {
    const out = ref.serialize();
    if (out.kind === "text") {
      await writeTextFile(tab.filePath, out.value);
    } else {
      await writeFile(tab.filePath, out.value);
    }
    tab.dirty = false;
    refreshTabsList();
    clearDraftForTab(tab);
    flashStatus(`Saved ${tab.filename}`);
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
}

// --- Whiteboard tab save helpers + creation ------------------------------

function handleNewWhiteboard() {
  let i = tabs.value.filter((t) => t.kind === "whiteboard").length + 1;
  let name;
  do {
    name = `untitled-${i}.sbw`;
    i++;
  } while (tabs.value.some((t) => t.filename === name));
  const tab = makeWhiteboardTab({ filename: name });
  tabs.value = [...tabs.value, tab];
  activateTab(tab.id);
  flashStatus(`New whiteboard: ${name}`);
}

async function saveWhiteboardTab(tab) {
  if (!tab.filePath) return saveWhiteboardTabAs(tab);
  const ref = whiteboardRefs[tab.id];
  if (!ref) {
    flashStatus("Whiteboard not ready yet — try again in a moment");
    return;
  }
  try {
    const json = ref.getBoardJson();
    await writeTextFile(tab.filePath, JSON.stringify(json));
    tab.dirty = false;
    refreshTabsList();
    clearDraftForTab(tab);
    flashStatus(`Saved ${tab.filename}`);
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
}

async function saveWhiteboardTabAs(tab) {
  const ref = whiteboardRefs[tab.id];
  if (!ref) {
    flashStatus("Whiteboard not ready yet — try again in a moment");
    return;
  }
  try {
    const chosen = await saveDialog({
      title: "Save Whiteboard",
      defaultPath: tab.filePath || tab.filename,
      filters: [
        { name: "Sparrow Whiteboard", extensions: ["sbw"] },
      ],
    });
    if (!chosen) return;
    const json = ref.getBoardJson();
    await writeTextFile(chosen, JSON.stringify(json));
    tab.filePath = chosen;
    tab.filename = basename(chosen);
    tab.dirty = false;
    refreshTabsList();
    clearDraftForTab(tab);
    flashStatus(`Saved ${tab.filename}`);
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
}

async function saveTableTabAs(tab) {
  const ref = tableRefs[tab.id];
  if (!ref) {
    flashStatus("Table not ready yet — try again in a moment");
    return;
  }
  try {
    const chosen = await saveDialog({
      title: "Save As",
      defaultPath: tab.filePath || tab.filename,
      filters: [
        { name: "CSV", extensions: ["csv"] },
        { name: "Excel Workbook (latest)", extensions: ["xlsx"] },
      ],
    });
    if (!chosen) return;
    // The chosen extension dictates the format — let the user convert by
    // renaming. Default to the tab's existing format if the extension is
    // unrecognized.
    const ext = extOf(chosen);
    const newFormat = ext === "csv" || ext === "xlsx" ? ext : tab.format;
    if (newFormat !== tab.format) tab.format = newFormat;
    const out = ref.serialize();
    if (out.kind === "text") {
      await writeTextFile(chosen, out.value);
    } else {
      await writeFile(chosen, out.value);
    }
    tab.filePath = chosen;
    tab.filename = basename(chosen);
    tab.dirty = false;
    refreshTabsList();
    clearDraftForTab(tab);
    flashStatus(`Saved ${tab.filename}`);
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
}

// Returns the lowercase extension (no dot) of a path, or empty string.
function extOf(path) {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : "";
}

function isTableExtension(ext) {
  return ext === "csv" || ext === "xlsx";
}

function isWhiteboardExtension(ext) {
  return ext === "sbw";
}

const PREVIEW_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tif",
  "tiff",
  "svg",
  "pdf",
]);

function isPreviewExtension(ext) {
  return PREVIEW_EXTENSIONS.has(ext);
}

// Routes a chosen file to either a text-editor tab or a table tab, based on
// its extension. Used by File → Open and by the File Explorer's click-to-open.
async function openPathSmart(path) {
  const ext = extOf(path);
  const filename = basename(path);
  // Already-open guard: cover all file-backed kinds.
  const existing = tabs.value.find(
    (t) =>
      (t.kind === "editor" ||
        t.kind === "table" ||
        t.kind === "whiteboard" ||
        t.kind === "preview") &&
      t.filePath === path
  );
  if (existing) {
    activateTab(existing.id);
    flashStatus(`Already open: ${filename}`);
    return;
  }
  try {
    if (isWhiteboardExtension(ext)) {
      const text = await readTextFile(path);
      let boardJson = null;
      try {
        boardJson = JSON.parse(text);
      } catch (_) {
        /* corrupt file — open it as an empty board so the user can
         start over rather than seeing nothing happen. */
      }
      const tab = makeWhiteboardTab({
        filename,
        filePath: path,
        boardJson,
      });
      tabs.value = [...tabs.value, tab];
      activateTab(tab.id);
      flashStatus(`Opened ${filename}`);
    } else if (isPreviewExtension(ext)) {
      // Read as bytes — images and PDF are binary, SVG is text but we
      // pipe its bytes through a Blob URL the same way to keep one
      // code path.
      const bytes = await readFile(path);
      const tab = makePreviewTab({
        filename,
        filePath: path,
        format: ext === "tif" ? "tiff" : ext,
        rawBytes: bytes,
      });
      tabs.value = [...tabs.value, tab];
      activateTab(tab.id);
      flashStatus(`Opened ${filename}`);
    } else if (isTableExtension(ext)) {
      let rawText = "";
      let rawBytes = null;
      if (ext === "csv") {
        rawText = await readTextFile(path);
      } else {
        rawBytes = await readFile(path);
      }
      const tab = makeTableTab({
        filename,
        filePath: path,
        format: ext,
        rawText,
        rawBytes,
      });
      tabs.value = [...tabs.value, tab];
      activateTab(tab.id);
      flashStatus(`Opened ${filename}`);
    } else {
      const contents = await readTextFile(path);
      const tab = makeEditorTab({
        filename,
        value: contents,
        filePath: path,
      });
      tabs.value = [...tabs.value, tab];
      activateTab(tab.id);
      flashStatus(`Opened ${filename}`);
    }
  } catch (err) {
    flashStatus(`Cannot open ${filename}: ${err}`);
  }
}

async function handleOpen() {
  try {
    const chosen = await openDialog({
      title: "Open File",
      multiple: false,
      directory: false,
    });
    if (!chosen) return;
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    await openPathSmart(path);
  } catch (err) {
    flashStatus(`Open failed: ${err}`);
  }
}

function handleTerminal() {
  addTerminalTab();
}

// ---------------------------------------------------------------------------
// File Explorer
// ---------------------------------------------------------------------------

async function handleFileExplorer() {
  // Re-use the native folder picker. The dialog plugin auto-scopes the
  // chosen path, but we don't rely on that since list_directory runs
  // through our own Rust command (not plugin-fs).
  try {
    const chosen = await openDialog({
      title: "Select a folder to browse",
      directory: true,
      multiple: false,
    });
    if (!chosen) return;
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    const tab = makeExplorerTab(path);
    tabs.value = [...tabs.value, tab];
    activateTab(tab.id);
    flashStatus(`Opened explorer: ${tab.filename}`);
  } catch (err) {
    flashStatus(`Could not open folder: ${err}`);
  }
}

// Called when the user clicks a file in any FileExplorerTab. Delegates to
// `openPathSmart` so CSV / XLSX also land in the table-tab kind.
function openFileFromExplorer(filePath) {
  return openPathSmart(filePath);
}

// ---------------------------------------------------------------------------
// .http "Send Request"
// ---------------------------------------------------------------------------

// True when the active tab is an editor tab with the `http` language —
// gates the visibility of the Send Request button.
const canSendRequest = computed(() => {
  // Same shallowRef caveat as isMarkdownActive — re-key off the version
  // so the Send Request button shows/hides correctly when the active
  // tab's language flips between http and something else.
  tabsVersion.value;
  return (
    activeTab.value?.kind === "editor" &&
    activeTab.value?.language === "http" &&
    !activeTab.value?.readOnly
  );
});

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Try to format the response body for nicer reading. Currently handles JSON
// (pretty-print) and leaves everything else untouched.
function maybeFormatBody(body, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch (_) {
      return body;
    }
  }
  return body;
}

function openResponseTab(req, res) {
  const headerBlock = [
    `HTTP/1.1 ${res.status} ${res.status_text}`,
    ...res.headers.map(([k, v]) => `${k}: ${v}`),
  ].join("\n");

  const formattedBody = maybeFormatBody(res.body, res.content_type);
  const lossyNote = res.body_was_lossy
    ? "# (body was not valid UTF-8 — replacement characters inserted)\n"
    : "";
  const content =
    `# ${req.method} ${req.url}\n` +
    `# ${res.duration_ms}ms • ${formatBytes(res.size_bytes)}` +
    `${res.content_type ? ` • ${res.content_type}` : ""}\n` +
    lossyNote +
    `\n` +
    headerBlock +
    `\n\n` +
    formattedBody;

  const tab = makeEditorTab({
    filename: `response-${responseCounter++}.http`,
    value: content,
    language: "http",
    readOnly: true,
  });
  tabs.value = [...tabs.value, tab];
  activateTab(tab.id);
}

// ---------------------------------------------------------------------------
// Spell check (CSpell, via cspell-trie-lib in a web worker)
// ---------------------------------------------------------------------------

function isSpellCheckable(tab) {
  return (
    tab.kind === "editor" &&
    !tab.readOnly &&
    SPELL_LANGUAGES.has(tab.language)
  );
}

function scheduleSpellCheck(tab) {
  if (!spellCheckEnabled.value || !isSpellCheckable(tab)) return;
  const existing = spellTimers.get(tab.id);
  if (existing) clearTimeout(existing);
  // 400 ms feels responsive while sparing the worker from per-keystroke runs.
  const t = setTimeout(() => {
    spellTimers.delete(tab.id);
    runSpellCheck(tab);
  }, 400);
  spellTimers.set(tab.id, t);
}

async function runSpellCheck(tab) {
  if (!spellCheckEnabled.value) return;
  if (!isSpellCheckable(tab)) return;
  const model = tab.model;
  if (!model || (model.isDisposed && model.isDisposed())) return;
  const textSnapshot = model.getValue();
  try {
    const issues = await spellCheckText(textSnapshot, tab.language);
    // The user may have flipped spell check off or closed the tab while we
    // were waiting — bail if so.
    if (!spellCheckEnabled.value) return;
    if (model.isDisposed && model.isDisposed()) return;
    applySpellMarkers(tab, issues);
  } catch (err) {
    console.warn("[spell-check] failed:", err);
  }
}

function applySpellMarkers(tab, issues) {
  const model = tab.model;
  const markers = issues.map((i) => {
    const start = model.getPositionAt(i.offset);
    const end = model.getPositionAt(i.offset + i.length);
    const suggList =
      i.suggestions && i.suggestions.length
        ? "\nSuggestions: " + i.suggestions.join(", ")
        : "";
    return {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
      message: `Possible misspelling: "${i.text}"${suggList}`,
      severity: monaco.MarkerSeverity.Info,
      source: "cspell",
    };
  });
  // Marker owner key 'cspell' isolates our markers from anything else
  // (e.g. Monaco's own JSON validator on .json tabs).
  monaco.editor.setModelMarkers(model, "cspell", markers);
}

function clearSpellMarkers(tab) {
  if (tab.kind !== "editor") return;
  const model = tab.model;
  if (!model || (model.isDisposed && model.isDisposed())) return;
  monaco.editor.setModelMarkers(model, "cspell", []);
}

// ---------------------------------------------------------------------------
// Markdown preview
// ---------------------------------------------------------------------------

function schedulePreviewUpdate(tab) {
  // Background tabs never paint a preview, so re-rendering them is wasted work.
  if (!isMarkdownActive.value) return;
  if (tab.id !== activeTabId.value) return;
  if (previewTimer) clearTimeout(previewTimer);
  // 150 ms is short enough to feel live, long enough to coalesce bursts.
  previewTimer = setTimeout(() => {
    previewTimer = null;
    updatePreviewNow();
  }, 150);
}

async function updatePreviewNow() {
  const tab = activeTab.value;
  if (!tab || tab.kind !== "editor" || tab.language !== "markdown") {
    previewHtml.value = "";
    return;
  }
  try {
    previewHtml.value = renderMarkdown(tab.model.getValue());
  } catch (err) {
    console.warn("[preview] markdown render failed:", err);
    previewHtml.value =
      '<p style="color:#f88;">Markdown render failed — see console.</p>';
    return;
  }
  // After Vue flushes the new HTML into the DOM, hand off to mermaid so
  // it can scan for `<div class="mermaid">` blocks and replace each with
  // a rendered SVG. No-op for previews that don't contain diagrams.
  await nextTick();
  if (previewPaneEl.value) {
    renderMermaidIn(previewPaneEl.value).catch((err) =>
      console.warn("[preview] mermaid pass failed:", err)
    );
  }
}

// Split view -----------------------------------------------------------------

function initEditor2() {
  if (editor2 || !editor2Container.value) return;
  editor2 = monaco.editor.create(editor2Container.value, {
    model: null,
    theme: theme.value,
    automaticLayout: true,
    fontSize: 14,
    // Less crowded in a narrower pane.
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
  });
  if (rightPanelTabId.value !== null) {
    applyRightPanelTab(rightPanelTabId.value);
  }
}

function disposeEditor2() {
  if (!editor2) return;
  // Stash the right pane's current cursor/scroll so toggling split off+on
  // returns to where the user left off.
  if (rightPanelTabId.value !== null) {
    try {
      editor2ViewStates.set(rightPanelTabId.value, editor2.saveViewState());
    } catch (_) {
      /* ignore */
    }
  }
  editor2.dispose();
  editor2 = null;
}

function applyRightPanelTab(tabId) {
  if (!editor2) return;
  const tab = tabs.value.find((t) => t.id === tabId);
  if (!tab || tab.kind !== "editor") {
    editor2.setModel(null);
    return;
  }
  editor2.setModel(tab.model);
  const vs = editor2ViewStates.get(tabId);
  if (vs) {
    try {
      editor2.restoreViewState(vs);
    } catch (_) {
      /* stale view state — fine */
    }
  }
  editor2.updateOptions({ readOnly: !!tab.readOnly });
  requestAnimationFrame(() => editor2 && editor2.layout());
}

function setRightPanelTab(rawValue) {
  // The select reports its value as a string; coerce empty to null.
  const id =
    rawValue === "" || rawValue == null ? null : Number(rawValue);
  // Save the outgoing pane's view state before swapping models.
  if (
    editor2 &&
    rightPanelTabId.value !== null &&
    rightPanelTabId.value !== id
  ) {
    try {
      editor2ViewStates.set(rightPanelTabId.value, editor2.saveViewState());
    } catch (_) {
      /* ignore */
    }
  }
  rightPanelTabId.value = id;
  if (id !== null) applyRightPanelTab(id);
  else if (editor2) editor2.setModel(null);
}

async function toggleSplitView() {
  splitView.value = !splitView.value;

  if (splitView.value) {
    // Pre-select a sensible tab for the right pane: a different editor tab
    // than what's on the left if we have one, otherwise reuse the active.
    if (rightPanelTabId.value === null) {
      const others = editorTabs.value.filter(
        (t) => t.id !== activeTabId.value
      );
      rightPanelTabId.value =
        others.length > 0
          ? others[0].id
          : editorTabs.value[0]?.id ?? null;
    }
    // Wait for v-if mount, then build the editor.
    await nextTick();
    initEditor2();
  } else {
    disposeEditor2();
  }
  // The left editor's container just changed width — relayout next frame.
  if (editor) requestAnimationFrame(() => editor.layout());
  flashStatus(splitView.value ? "Split view on" : "Split view off");
}

function closeSplitView() {
  if (!splitView.value) return;
  splitView.value = false;
  rightPanelTabId.value = null;
  disposeEditor2();
  if (editor) requestAnimationFrame(() => editor.layout());
}

function togglePreview() {
  showPreview.value = !showPreview.value;
  if (showPreview.value && isMarkdownActive.value) {
    updatePreviewNow();
  }
  // The editor host's width changed — force a relayout next frame so Monaco
  // picks up the new size without waiting for its ResizeObserver to fire.
  if (editor) {
    requestAnimationFrame(() => editor.layout());
  }
  flashStatus(showPreview.value ? "Preview on" : "Preview off");
}

// ---------------------------------------------------------------------------
// Monaco-driven Edit menu actions (Find / Replace / Go to Line)
// ---------------------------------------------------------------------------
//
// The Edit menu's Find, Replace, and Go-to-Line items emit menu events that
// land here. We focus the editor and run Monaco's built-in action by id —
// Monaco renders its own widgets (find overlay, replace overlay, goto-line
// quick input), so nothing else for us to draw.

function runEditorAction(actionId) {
  if (!editor || !isEditorActive.value) {
    flashStatus("This action works on editor tabs only");
    return;
  }
  editor.focus();
  const action = editor.getAction(actionId);
  if (action) {
    action.run();
    return;
  }
  // Help debug missing action ids — Monaco's action registry varies between
  // versions, and a typo or removed action otherwise just looks like silence.
  try {
    const ids = editor.getSupportedActions().map((a) => a.id);
    console.warn(
      `[editor] action "${actionId}" not found. ${ids.length} actions registered.`,
      ids.slice(0, 40)
    );
  } catch (_) {
    /* ignore */
  }
  flashStatus(`Editor action not available: ${actionId}`);
}

function handleFind() {
  runEditorAction("actions.find");
}

function handleReplace() {
  runEditorAction("editor.action.startFindReplaceAction");
}

function handleGotoLine() {
  runEditorAction("editor.action.gotoLine");
}

// Format Document / Format Selection invoke Monaco's registered formatters.
// Built-in coverage: JSON, HTML, CSS, JS/TS. Other languages will show a
// friendly status if no formatter has been registered for them.
function handleFormatDocument() {
  runEditorAction("editor.action.formatDocument");
}
function handleFormatSelection() {
  runEditorAction("editor.action.formatSelection");
}

// Select All gets its own handler because Monaco doesn't expose
// `editor.action.selectAll` through the action registry — the Cmd/Ctrl+A
// keybinding is wired straight to `setSelection(getFullModelRange())`.
// `editor.getAction("editor.action.selectAll")` returns null, which is
// what produced the "action not available" message.
function handleSelectAll() {
  if (!editor || !isEditorActive.value) {
    flashStatus("Select All works on editor tabs only");
    return;
  }
  const model = editor.getModel();
  if (!model) return;
  editor.focus();
  editor.setSelection(model.getFullModelRange());
}

function toggleSpellCheck() {
  spellCheckEnabled.value = !spellCheckEnabled.value;
  if (spellCheckEnabled.value) {
    for (const t of tabs.value) scheduleSpellCheck(t);
    flashStatus("Spell check on");
  } else {
    // Cancel pending timers and clear existing squiggles across all tabs.
    for (const [, timer] of spellTimers) clearTimeout(timer);
    spellTimers.clear();
    for (const t of tabs.value) clearSpellMarkers(t);
    flashStatus("Spell check off");
  }
}

async function handleSendRequest() {
  const tab = activeTab.value;
  if (!tab || tab.kind !== "editor" || tab.language !== "http") return;

  const text = tab.model.getValue();
  const pos = editor?.getPosition();
  const cursorLine1 = pos ? pos.lineNumber : 1;
  const req = findRequestAtCursor(text, cursorLine1);
  if (!req) {
    flashStatus("No request found in this file");
    return;
  }

  flashStatus(`Sending ${req.method} ${req.url} ...`);
  try {
    const res = await invoke("send_http_request", {
      input: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
      },
    });
    openResponseTab(req, res);
    flashStatus(
      `${res.status} ${res.status_text} • ${res.duration_ms}ms • ${formatBytes(res.size_bytes)}`,
      4000
    );
  } catch (err) {
    flashStatus(`Request failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// AI Assist
// ---------------------------------------------------------------------------
//
// Flow:
//   1. User selects text in the editor.
//   2. They click the AI button (toolbar) or pick Tools → AI Assist.
//   3. A modal shows the selected text + a textarea for their instruction.
//   4. On Run, we call the Rust `ai_complete` command with the configured
//      provider/key/model and wait for the response.
//   5. The result is inserted right below the selection, bracketed by
//      `--- AI assist ---` / `--- end ---` markers so it's easy to identify
//      (and easy to delete after copy-pasting).

const aiDialogOpen = ref(false);
const aiSelectedText = ref("");
const aiSelectionRange = ref(null); // Monaco IRange snapshot
const aiPrompt = ref("");
const aiLoading = ref(false);
const aiError = ref("");
const aiPromptInput = ref(null);

const aiSettingsOpen = ref(false);
// Working copy of the config, only committed on Save. Starts with the
// in-memory defaults; the real value is loaded from disk as soon as the
// user opens the AI Settings modal or invokes AI Assist.
const aiConfigDraft = ref({
  provider: "openai",
  apiKey: "",
  openaiModel: "gpt-4o-mini",
  anthropicModel: "claude-3-5-sonnet-latest",
  systemPrompt: "",
  maxTokens: 2048,
});

async function handleAiAssist() {
  if (!editor) {
    flashStatus("AI Assist: no editor focused");
    return;
  }
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model) {
    flashStatus("AI Assist: no editor focused");
    return;
  }
  const selected = model.getValueInRange(sel);
  if (!selected.trim()) {
    flashStatus("AI Assist: select some text first");
    return;
  }
  if (!(await isAiConfigured())) {
    flashStatus("AI not configured — opening settings");
    await openAiSettings();
    return;
  }
  aiSelectedText.value = selected;
  // Clone the range — Monaco's selection object mutates as the user types.
  aiSelectionRange.value = {
    startLineNumber: sel.startLineNumber,
    startColumn: sel.startColumn,
    endLineNumber: sel.endLineNumber,
    endColumn: sel.endColumn,
  };
  aiPrompt.value = "";
  aiError.value = "";
  aiDialogOpen.value = true;
  nextTick(() => {
    if (aiPromptInput.value) aiPromptInput.value.focus();
  });
}

function closeAiDialog() {
  if (aiLoading.value) return;
  aiDialogOpen.value = false;
}

async function runAiAssist() {
  const instruction = aiPrompt.value.trim();
  if (!instruction) return;
  const cfg = await getAiConfig();
  if (!cfg.apiKey) {
    aiError.value = "No API key configured. Open AI Settings first.";
    return;
  }
  aiLoading.value = true;
  aiError.value = "";

  // The Rust command takes the full prompt; we stitch the selection and
  // instruction together here. The fenced block keeps the boundary clear.
  const fullPrompt =
    `Selected text:\n\`\`\`\n${aiSelectedText.value}\n\`\`\`\n\n` +
    `Instruction: ${instruction}`;

  try {
    const res = await invoke("ai_complete", {
      input: {
        provider: cfg.provider,
        api_key: cfg.apiKey,
        model: modelForProvider(cfg),
        prompt: fullPrompt,
        system: cfg.systemPrompt,
        max_tokens: cfg.maxTokens || 2048,
      },
    });
    insertAiResult(res.text);
    flashStatus(`AI replied in ${res.duration_ms}ms`);
    aiDialogOpen.value = false;
  } catch (err) {
    aiError.value = String(err);
  } finally {
    aiLoading.value = false;
  }
}

function insertAiResult(text) {
  if (!editor || !aiSelectionRange.value) return;
  const model = editor.getModel();
  if (!model) return;
  const range = aiSelectionRange.value;
  // Insert at the end of the last selection line, on a new paragraph.
  const endLineMaxCol = model.getLineMaxColumn(range.endLineNumber);
  const insertRange = new monaco.Range(
    range.endLineNumber,
    endLineMaxCol,
    range.endLineNumber,
    endLineMaxCol
  );
  const formatted = `\n\n--- AI assist ---\n${text}\n--- end ---\n`;
  editor.executeEdits("ai-assist", [
    { range: insertRange, text: formatted, forceMoveMarkers: true },
  ]);
  // Move the cursor to just after the inserted block so the user can keep typing.
  const insertedLines = formatted.split("\n").length - 1;
  const newLine = range.endLineNumber + insertedLines;
  editor.setPosition({
    lineNumber: newLine,
    column: model.getLineMaxColumn(newLine),
  });
  editor.focus();
}

async function openAiSettings() {
  try {
    aiConfigDraft.value = await getAiConfig();
  } catch (err) {
    flashStatus(`Couldn't load AI config: ${err}`);
  }
  aiSettingsOpen.value = true;
}

function closeAiSettings() {
  aiSettingsOpen.value = false;
}

async function saveAiSettings() {
  try {
    await saveAiConfig({ ...aiConfigDraft.value });
    flashStatus("AI settings saved");
  } catch (err) {
    flashStatus(`Save failed: ${err}`);
  }
  aiSettingsOpen.value = false;
}

// ---------------------------------------------------------------------------
// Window-close guard
// ---------------------------------------------------------------------------
//
// Intercept the OS close request (X button, Cmd+Q, File → Quit) and, if any
// tabs are dirty, hold the close until the user picks Save All / Discard /
// Cancel. Tabs without a file path get listed but can't be auto-saved —
// "Save All" only writes tabs that already have a location, and the modal
// flags untitled ones so the user knows they'll be lost if they continue.

const closeConfirmOpen = ref(false);
const dirtyTabsBeforeClose = ref([]); // snapshot at the moment of close request
let pendingClose = false; // true while we're the one driving the close
let unlistenClose = null;

async function handleCloseRequested(event) {
  if (pendingClose) return; // our own exit is in flight — let it run
  if (closeConfirmOpen.value) {
    // Already prompting; ignore additional close events.
    event.preventDefault();
    return;
  }
  const dirty = tabs.value.filter((t) => !!t.dirty);
  if (dirty.length === 0) {
    // No dirty tabs. We *could* return without preventDefault and let
    // Tauri's destroy run, but on macOS that leaves the app alive in
    // the Dock — and `WindowEvent::Destroyed` doesn't reliably fire
    // across all Tauri 2 versions. Cleanest fix is to skip the close
    // flow and exit the whole process directly.
    event.preventDefault();
    await actuallyExit();
    return;
  }
  event.preventDefault();
  dirtyTabsBeforeClose.value = dirty;
  closeConfirmOpen.value = true;
}

function cancelClose() {
  closeConfirmOpen.value = false;
  dirtyTabsBeforeClose.value = [];
}

// Fully exit the app process. Used by every "approved close" path
// (Discard, Save All, X with no dirty tabs). Going through
// plugin-process's `exit()` instead of `window.close()` avoids the
// macOS "stay alive in the Dock" behavior and sidesteps any Tauri
// version differences in the `Destroyed` event lifecycle.
async function actuallyExit() {
  pendingClose = true;
  try {
    await processExit(0);
  } catch (err) {
    console.error("[close-guard] exit failed:", err);
    pendingClose = false;
  }
}

async function discardAndClose() {
  closeConfirmOpen.value = false;
  await actuallyExit();
}

// Best-effort save for one tab. Returns true on success (or "nothing to save"),
// false if it tried and failed. Skips tabs without a filePath — those need
// Save As, which would block the quit flow on a dialog per tab.
async function saveDirtyTabForClose(tab) {
  if (!tab.filePath) return false; // untitled — caller flags it as skipped
  try {
    if (tab.kind === "editor") {
      await writeTextFile(tab.filePath, tab.model.getValue());
    } else if (tab.kind === "table") {
      const ref = tableRefs[tab.id];
      if (!ref) return false;
      const out = ref.serialize();
      if (out.kind === "text") {
        await writeTextFile(tab.filePath, out.value);
      } else {
        await writeFile(tab.filePath, out.value);
      }
    } else if (tab.kind === "whiteboard") {
      const ref = whiteboardRefs[tab.id];
      if (!ref) return false;
      const json = ref.getBoardJson();
      await writeTextFile(tab.filePath, JSON.stringify(json));
    } else {
      // Other kinds (terminal, explorer, preview) aren't ever dirty —
      // ignore them gracefully.
      return true;
    }
    tab.dirty = false;
    clearDraftForTab(tab);
    return true;
  } catch (err) {
    console.error(`[close-guard] save failed for ${tab.filename}:`, err);
    return false;
  }
}

async function saveAllAndClose() {
  // Snapshot the list so toggling state mid-loop doesn't break us.
  const list = [...dirtyTabsBeforeClose.value];
  const failures = [];
  for (const tab of list) {
    if (!tab.filePath) continue; // untitled; user was warned in the dialog
    const ok = await saveDirtyTabForClose(tab);
    if (!ok) failures.push(tab.filename);
  }
  refreshTabsList();
  if (failures.length > 0) {
    // Don't quit if we couldn't save everything — bail back to the editor.
    flashStatus(
      `Couldn't save: ${failures.join(", ")} — see console.`,
      6000
    );
    closeConfirmOpen.value = false;
    return;
  }
  closeConfirmOpen.value = false;
  await actuallyExit();
}

// ---------------------------------------------------------------------------
// Autosave / draft recovery
// ---------------------------------------------------------------------------
//
// Whenever a savable tab goes dirty we kick off a 2-second debounce; on
// fire we serialize the tab's current state into a draft file under
// $APPLOCALDATA/drafts/<draftKey>.json. The draft is deleted once the
// user successfully saves the tab to its real on-disk location (or
// chooses Discard / Discard All in the recovery modal on next startup).

const AUTOSAVE_DELAY_MS = 2000;
const draftTimers = new Map(); // tabId → setTimeout handle
let draftRestoreInProgress = false;

const draftsToRecover = ref([]);
const recoveryDialogOpen = ref(false);

function uint8ToBase64(bytes) {
  let bin = "";
  // Chunk to avoid blowing the call stack on large files.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk)
    );
  }
  return btoa(bin);
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function isSavableKind(kind) {
  return kind === "editor" || kind === "table" || kind === "whiteboard";
}

function scheduleDraftSave(tab) {
  if (!tab || !tab.draftKey) return;
  if (!isSavableKind(tab.kind)) return;
  if (!tab.dirty) return;
  const existing = draftTimers.get(tab.id);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    draftTimers.delete(tab.id);
    writeDraftForTab(tab).catch((err) =>
      console.warn("[drafts] write failed:", err)
    );
  }, AUTOSAVE_DELAY_MS);
  draftTimers.set(tab.id, t);
}

async function writeDraftForTab(tab) {
  if (!tab || !tab.dirty || !tab.draftKey) return;
  const base = {
    draftKey: tab.draftKey,
    kind: tab.kind,
    filename: tab.filename,
    filePath: tab.filePath || null,
    savedAt: Date.now(),
  };
  if (tab.kind === "editor") {
    await writeDraft({
      ...base,
      language: tab.language,
      payload: { content: tab.model.getValue() },
    });
  } else if (tab.kind === "table") {
    const ref = tableRefs[tab.id];
    if (!ref) return; // component not ready
    const out = ref.serialize();
    const payload =
      out.kind === "text"
        ? { format: tab.format, csvText: out.value }
        : { format: tab.format, xlsxBase64: uint8ToBase64(out.value) };
    await writeDraft({
      ...base,
      format: tab.format,
      payload,
    });
  } else if (tab.kind === "whiteboard") {
    const ref = whiteboardRefs[tab.id];
    if (!ref) return;
    await writeDraft({
      ...base,
      payload: { boardJson: ref.getBoardJson() },
    });
  }
}

function clearDraftForTab(tab) {
  if (!tab || !tab.draftKey) return;
  // Cancel any pending autosave so it doesn't recreate the file we just
  // deleted right after a successful Save.
  const pending = draftTimers.get(tab.id);
  if (pending) {
    clearTimeout(pending);
    draftTimers.delete(tab.id);
  }
  deleteDraft(tab.draftKey).catch(() => {
    /* deletion is best-effort */
  });
}

function iconForDraft(d) {
  if (d.kind === "table") return FileSpreadsheet;
  if (d.kind === "whiteboard") return PenTool;
  return FileText;
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function checkForDraftsAtStartup() {
  try {
    const drafts = await readAllDrafts();
    if (drafts.length === 0) return;
    draftsToRecover.value = drafts;
    recoveryDialogOpen.value = true;
  } catch (err) {
    console.warn("[drafts] startup scan failed:", err);
  }
}

async function restoreDraft(draft) {
  if (!draft) return;
  draftRestoreInProgress = true;
  try {
    let tab = null;
    if (draft.kind === "editor") {
      tab = makeEditorTab({
        filename: draft.filename,
        value: draft.payload?.content ?? "",
        filePath: draft.filePath || null,
        language: draft.language,
      });
    } else if (draft.kind === "table") {
      const p = draft.payload || {};
      const fmt = draft.format || p.format || "csv";
      let rawText = "";
      let rawBytes = null;
      if (fmt === "csv") {
        rawText = p.csvText || "";
      } else {
        rawBytes = p.xlsxBase64
          ? base64ToUint8(p.xlsxBase64)
          : null;
      }
      tab = makeTableTab({
        filename: draft.filename,
        filePath: draft.filePath || null,
        format: fmt,
        rawText,
        rawBytes,
      });
    } else if (draft.kind === "whiteboard") {
      tab = makeWhiteboardTab({
        filename: draft.filename,
        filePath: draft.filePath || null,
        boardJson: draft.payload?.boardJson || null,
      });
    }
    if (tab) {
      // Reuse the draft's own key so future autosaves overwrite the same
      // file (instead of leaving the recovered draft hanging around).
      tab.draftKey = draft.draftKey;
      tab.dirty = true;
      tabs.value = [...tabs.value, tab];
      activateTab(tab.id);
    }
    draftsToRecover.value = draftsToRecover.value.filter(
      (d) => d.draftKey !== draft.draftKey
    );
    if (draftsToRecover.value.length === 0) {
      recoveryDialogOpen.value = false;
    }
  } catch (err) {
    flashStatus(`Restore failed: ${err}`, 5000);
  } finally {
    draftRestoreInProgress = false;
  }
}

async function discardDraft(draft) {
  if (!draft) return;
  await deleteDraft(draft.draftKey);
  draftsToRecover.value = draftsToRecover.value.filter(
    (d) => d.draftKey !== draft.draftKey
  );
  if (draftsToRecover.value.length === 0) {
    recoveryDialogOpen.value = false;
  }
}

async function restoreAllDrafts() {
  const list = [...draftsToRecover.value];
  for (const d of list) {
    // eslint-disable-next-line no-await-in-loop
    await restoreDraft(d);
  }
}

async function discardAllDrafts() {
  if (
    !window.confirm(
      `Discard all ${draftsToRecover.value.length} drafts? This can't be undone.`
    )
  ) {
    return;
  }
  const list = [...draftsToRecover.value];
  for (const d of list) {
    // eslint-disable-next-line no-await-in-loop
    await discardDraft(d);
  }
}

// ---------------------------------------------------------------------------
// Auto-updater
// ---------------------------------------------------------------------------
//
// The Rust side wires up tauri-plugin-updater. We expose two flows here:
//   - A silent check 8 s after launch; if a signed newer build is on the
//     feed we open the update modal.
//   - File → Check for Updates… (menu) — same check but flashes "up to
//     date" if nothing's available.

const pendingUpdate = ref(null);
const updateDialogOpen = ref(false);
const updateInstalling = ref(false);
const updateProgress = ref(0); // 0..1

async function handleCheckUpdates(opts = {}) {
  const silent = opts.silent === true;
  try {
    const update = await checkForUpdate();
    if (!update) {
      if (!silent) flashStatus("Sparrow is up to date");
      return;
    }
    pendingUpdate.value = update;
    updateProgress.value = 0;
    updateInstalling.value = false;
    updateDialogOpen.value = true;
  } catch (err) {
    if (!silent) {
      flashStatus(`Update check failed: ${err}`, 5000);
    }
    console.warn("[updater] check failed:", err);
  }
}

async function confirmInstallUpdate() {
  const update = pendingUpdate.value;
  if (!update) return;
  updateInstalling.value = true;
  updateProgress.value = 0;
  try {
    await installAndRelaunch(update, ({ downloaded, total }) => {
      updateProgress.value = total > 0 ? downloaded / total : 0;
    });
    // installAndRelaunch calls relaunch() — execution should not continue.
  } catch (err) {
    flashStatus(`Update failed: ${err}`, 6000);
    console.error("[updater] install failed:", err);
    updateInstalling.value = false;
  }
}

function dismissUpdate() {
  if (updateInstalling.value) return;
  updateDialogOpen.value = false;
  pendingUpdate.value = null;
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------
//
// Two flows:
//   - Save Snippet — capture the current editor selection, prompt for a
//     name + optional description, persist to localStorage.
//   - Snippets library — searchable list of saved snippets; click a row to
//     insert it at the cursor (or replace the current selection), or hit
//     the trash icon to delete it.

const saveSnippetDialogOpen = ref(false);
const snippetsDialogOpen = ref(false);
const snippetDraft = ref({
  name: "",
  type: "text",
  description: "",
  content: "",
  language: "",
});
const snippetsList = ref([]);
const snippetSearchQuery = ref("");
const snippetNameInput = ref(null);
const snippetSearchInput = ref(null);

const filteredSnippets = computed(() => {
  const q = snippetSearchQuery.value.trim().toLowerCase();
  if (!q) return snippetsList.value;
  return snippetsList.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q) ||
      s.content.toLowerCase().includes(q)
  );
});

function refreshSnippetsList() {
  snippetsList.value = getSnippets();
}

function handleSaveSnippet() {
  if (!editor || !isEditorActive.value) {
    flashStatus("Open an editor tab to save a snippet");
    return;
  }
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model) {
    flashStatus("Select some text to save as a snippet");
    return;
  }
  const selected = model.getValueInRange(sel);
  if (!selected.trim()) {
    flashStatus("Select some text to save as a snippet");
    return;
  }
  snippetDraft.value = {
    name: "",
    type: "text",
    description: "",
    content: selected,
    language: activeTab.value?.language || "plaintext",
  };
  saveSnippetDialogOpen.value = true;
  nextTick(() => {
    if (snippetNameInput.value) snippetNameInput.value.focus();
  });
}

// "+ New" entry from inside the Snippets library — opens the same modal
// without requiring an editor selection. Defaults to "prompt" since text
// snippets are usually saved via the toolbar's bookmark+ button.
function openNewSnippetDialog() {
  snippetDraft.value = {
    name: "",
    type: "prompt",
    description: "",
    content: "",
    language: activeTab.value?.language || "",
  };
  saveSnippetDialogOpen.value = true;
  nextTick(() => {
    if (snippetNameInput.value) snippetNameInput.value.focus();
  });
}

function commitSaveSnippet() {
  const name = snippetDraft.value.name.trim();
  if (!name) return;
  if (!snippetDraft.value.content.trim()) return;
  saveSnippet({
    name,
    type: snippetDraft.value.type,
    description: snippetDraft.value.description,
    content: snippetDraft.value.content,
    language: snippetDraft.value.language,
  });
  saveSnippetDialogOpen.value = false;
  refreshSnippetsList();
  flashStatus(`Snippet saved: ${name}`);
}

function openSnippetsDialog() {
  refreshSnippetsList();
  snippetSearchQuery.value = "";
  snippetsDialogOpen.value = true;
  nextTick(() => {
    if (snippetSearchInput.value) snippetSearchInput.value.focus();
  });
}

function insertSnippet(snippet) {
  if (!editor || !isEditorActive.value) {
    flashStatus("Open an editor tab to insert a snippet");
    return;
  }
  editor.focus();
  // Use the current selection — Monaco gives us a zero-length range at the
  // caret if nothing's selected, so executeEdits transparently does either
  // "replace selection" or "insert at caret".
  const range = editor.getSelection();
  if (!range) return;
  editor.executeEdits("snippet", [
    {
      range,
      text: snippet.content,
      forceMoveMarkers: true,
    },
  ]);
  flashStatus(`Inserted: ${snippet.name}`);
}

function pickSnippet(snippet) {
  if (snippet.type === "prompt") {
    runPromptSnippet(snippet);
  } else {
    insertSnippet(snippet);
  }
  snippetsDialogOpen.value = false;
}

// Run a saved prompt snippet through the AI. The snippet's content is the
// instruction; the editor's current selection (if any) is included as
// context. If there's a selection, the AI's reply replaces it directly; if
// not, the reply is inserted at the cursor wrapped in marker lines so it's
// easy to identify and clean up.
async function runPromptSnippet(snippet) {
  if (!editor || !isEditorActive.value) {
    flashStatus("Open an editor tab to run a prompt snippet");
    return;
  }
  if (!(await isAiConfigured())) {
    flashStatus("AI not configured — opening settings");
    await openAiSettings();
    return;
  }
  const model = editor.getModel();
  if (!model) return;

  const sel = editor.getSelection();
  const hasSelection = !!(sel && !sel.isEmpty());
  const selectedText = hasSelection ? model.getValueInRange(sel) : "";

  // Snapshot the selection range — Monaco's selection object will move as
  // edits are applied, but we want to replace what the user originally had
  // selected when they clicked the prompt.
  const targetRange = hasSelection
    ? {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      }
    : null;

  const instruction = (snippet.content || "").trim();
  const fullPrompt = hasSelection
    ? `Selected text:\n\`\`\`\n${selectedText}\n\`\`\`\n\nInstruction: ${instruction}`
    : instruction;

  const cfg = await getAiConfig();
  flashStatus(`Running prompt: ${snippet.name}…`);
  try {
    const res = await invoke("ai_complete", {
      input: {
        provider: cfg.provider,
        api_key: cfg.apiKey,
        model: modelForProvider(cfg),
        prompt: fullPrompt,
        system: cfg.systemPrompt,
        max_tokens: cfg.maxTokens || 2048,
      },
    });

    if (hasSelection && targetRange) {
      const range = new monaco.Range(
        targetRange.startLineNumber,
        targetRange.startColumn,
        targetRange.endLineNumber,
        targetRange.endColumn
      );
      editor.executeEdits("prompt-snippet", [
        { range, text: res.text, forceMoveMarkers: true },
      ]);
    } else {
      const pos = editor.getPosition();
      const endCol = model.getLineMaxColumn(pos.lineNumber);
      const insertRange = new monaco.Range(
        pos.lineNumber,
        endCol,
        pos.lineNumber,
        endCol
      );
      const formatted = `\n\n--- ${snippet.name} ---\n${res.text}\n--- end ---\n`;
      editor.executeEdits("prompt-snippet", [
        { range: insertRange, text: formatted, forceMoveMarkers: true },
      ]);
    }
    flashStatus(`${snippet.name} • ${res.duration_ms}ms`);
  } catch (err) {
    flashStatus(`Prompt failed: ${err}`, 5000);
  }
}

function removeSnippet(id, event) {
  if (event) event.stopPropagation();
  if (!window.confirm("Delete this snippet?")) return;
  deleteSnippet(id);
  refreshSnippetsList();
  flashStatus("Snippet deleted");
}

// ---------------------------------------------------------------------------
// Quick Actions
// ---------------------------------------------------------------------------
//
// A quick action is a saved command-line string with template variables.
// Running it spawns a new terminal tab pre-loaded with the substituted
// command — the TerminalTab component writes the command to the PTY after
// the shell prompt renders.

const actionsDialogOpen = ref(false);
const newActionDialogOpen = ref(false);
const actionsList = ref([]);
const actionSearchQuery = ref("");
const actionDraft = ref({
  name: "",
  type: "shell",
  command: "",
  scriptPath: "",
  args: "",
  description: "",
});
const actionSearchInput = ref(null);
const actionNameInput = ref(null);

const filteredActions = computed(() => {
  const q = actionSearchQuery.value.trim().toLowerCase();
  if (!q) return actionsList.value;
  return actionsList.value.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      (a.description || "").toLowerCase().includes(q) ||
      a.command.toLowerCase().includes(q)
  );
});

function refreshActionsList() {
  actionsList.value = getActions();
}

// Build a substitution context from the currently active tab + any editor
// selection. Returns empty strings rather than nulls so the regex replace
// keeps things tidy when a variable doesn't apply (e.g. {file} on a tab
// that hasn't been saved yet).
function getActionContext() {
  const ctx = {
    file: "",
    dir: "",
    filename: "",
    basename: "",
    ext: "",
    selection: "",
  };
  const tab = activeTab.value;
  if (tab) {
    if (tab.kind === "editor" && tab.filePath) {
      ctx.file = tab.filePath;
      const sepIdx = Math.max(
        ctx.file.lastIndexOf("/"),
        ctx.file.lastIndexOf("\\")
      );
      ctx.dir = sepIdx >= 0 ? ctx.file.slice(0, sepIdx) : "";
      ctx.filename = sepIdx >= 0 ? ctx.file.slice(sepIdx + 1) : ctx.file;
      const dotIdx = ctx.filename.lastIndexOf(".");
      ctx.basename =
        dotIdx > 0 ? ctx.filename.slice(0, dotIdx) : ctx.filename;
      ctx.ext = dotIdx > 0 ? ctx.filename.slice(dotIdx + 1) : "";
    } else if (tab.kind === "explorer" && tab.folderPath) {
      ctx.dir = tab.folderPath;
    }
  }
  if (editor && isEditorActive.value) {
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (sel && model) ctx.selection = model.getValueInRange(sel);
  }
  return ctx;
}

function interpolateCommand(template, ctx) {
  return template
    .replace(/\{file\}/g, ctx.file)
    .replace(/\{dir\}/g, ctx.dir)
    .replace(/\{filename\}/g, ctx.filename)
    .replace(/\{basename\}/g, ctx.basename)
    .replace(/\{ext\}/g, ctx.ext)
    .replace(/\{selection\}/g, ctx.selection);
}

function openActionsDialog() {
  refreshActionsList();
  actionSearchQuery.value = "";
  actionsDialogOpen.value = true;
  nextTick(() => {
    if (actionSearchInput.value) actionSearchInput.value.focus();
  });
}

function openNewActionDialog() {
  actionDraft.value = {
    name: "",
    type: "shell",
    command: "",
    scriptPath: "",
    args: "",
    description: "",
  };
  newActionDialogOpen.value = true;
  nextTick(() => {
    if (actionNameInput.value) actionNameInput.value.focus();
  });
}

async function pickActionScriptPath() {
  try {
    const chosen = await openDialog({
      title: "Pick Python script",
      multiple: false,
      directory: false,
      filters: [{ name: "Python", extensions: ["py"] }],
    });
    if (!chosen) return;
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    actionDraft.value.scriptPath = path;
  } catch (err) {
    flashStatus(`Could not pick script: ${err}`);
  }
}

function commitNewAction() {
  const name = actionDraft.value.name.trim();
  if (!name) return;
  const type = actionDraft.value.type || "shell";
  // Required-field validation depends on the type.
  if (type === "shell" && !actionDraft.value.command.trim()) return;
  if (type === "python" && !actionDraft.value.scriptPath.trim()) return;
  saveAction({
    name,
    type,
    command: actionDraft.value.command,
    scriptPath: actionDraft.value.scriptPath,
    args: actionDraft.value.args,
    description: actionDraft.value.description,
  });
  newActionDialogOpen.value = false;
  refreshActionsList();
  flashStatus(`Action saved: ${name}`);
}

function runAction(action) {
  // Legacy actions saved before the type field default to "shell".
  const type = action.type === "python" ? "python" : "shell";
  if (type === "python") {
    runPythonAction(action);
  } else {
    const command = interpolateCommand(action.command, getActionContext());
    const tab = makeTerminalTab({
      filename: action.name,
      initialCommand: command,
    });
    tabs.value = [...tabs.value, tab];
    activateTab(tab.id);
    flashStatus(`Running: ${action.name}`);
  }
  actionsDialogOpen.value = false;
}

// Python-action execution: pipes the active selection (or whole file) into
// `python <script>`, then replaces that range with the script's stdout.
async function runPythonAction(action) {
  if (!editor || !isEditorActive.value) {
    flashStatus("Open an editor tab to run a Python action");
    return;
  }
  const model = editor.getModel();
  if (!model) return;
  if (!action.scriptPath) {
    flashStatus("This action has no script path configured");
    return;
  }

  const sel = editor.getSelection();
  const hasSelection = !!(sel && !sel.isEmpty());
  const range = hasSelection ? sel : model.getFullModelRange();
  const stdinContent = model.getValueInRange(range);

  const ctx = getActionContext();
  // Tokenize the args field on whitespace. Users who need shell-grade
  // quoting can move that complexity into the script itself; we keep this
  // tokenizer dumb on purpose.
  const argsList = interpolateCommand(action.args || "", ctx)
    .split(/\s+/)
    .filter(Boolean);

  const env = [
    ["SPARROW_FILE", ctx.file],
    ["SPARROW_DIR", ctx.dir],
    ["SPARROW_FILENAME", ctx.filename],
    ["SPARROW_BASENAME", ctx.basename],
    ["SPARROW_EXT", ctx.ext],
    ["SPARROW_LANGUAGE", activeTab.value?.language || ""],
    ["SPARROW_HAS_SELECTION", hasSelection ? "1" : "0"],
  ];

  flashStatus(`Running: ${action.name}…`);
  try {
    const res = await invoke("run_python_action", {
      input: {
        script_path: action.scriptPath,
        args: argsList,
        env,
        stdin: stdinContent,
        cwd: ctx.dir || null,
      },
    });
    if (res.exit_code !== 0) {
      const stderr =
        res.stderr && res.stderr.trim()
          ? res.stderr.trim().split("\n").slice(-3).join(" | ")
          : `exit ${res.exit_code}`;
      console.error("[python-action] stderr:", res.stderr);
      flashStatus(`Action failed: ${stderr}`, 5000);
      return;
    }
    // Apply the result. If the script outputs nothing, we still apply it
    // (effectively deleting the selection) — that's the right behavior for
    // filters that intentionally strip content.
    editor.executeEdits("python-action", [
      {
        range,
        text: res.stdout,
        forceMoveMarkers: true,
      },
    ]);
    flashStatus(`${action.name} • ${res.duration_ms}ms`);
  } catch (err) {
    flashStatus(`Action failed: ${err}`, 5000);
  }
}

function removeAction(id, event) {
  if (event) event.stopPropagation();
  if (!window.confirm("Delete this action?")) return;
  deleteAction(id);
  refreshActionsList();
  flashStatus("Action deleted");
}

// ---------------------------------------------------------------------------
// Editor lifecycle + menu wiring
// ---------------------------------------------------------------------------

const theme = ref(
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs"
);
watch(theme, (t) => monaco.editor.setTheme(t));

let unlistenMenu = null;

onMounted(async () => {
  editor = monaco.editor.create(editorContainer.value, {
    model: null,
    theme: theme.value,
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
  });

  // Populate the status-bar language list now that all custom languages
  // (e.g. our `.http` language) are registered.
  loadLanguageList();

  // Pre-loaded starter tabs are commented out — the app boots empty and
  // the user opens whatever they actually want via File → New / Open or
  // by clicking a file in the explorer. Uncomment any of these if you
  // want a demo session on a fresh install.
  //
  //   addEditorTab("welcome.js");      // JS sample with greeting fn
  //   addEditorTab("example.http");    // REST Client request sample
  //   addEditorTab("notes.md");        // Markdown sample (preview demo)

  // Look for autosaved drafts left over from a prior session and offer to
  // recover them. Runs after the starter tabs so the UI isn't empty while
  // the user decides.
  checkForDraftsAtStartup();

  // Quietly check the update feed a few seconds after launch so it
  // doesn't compete with first paint. Failures (offline, feed missing,
  // dev build) are swallowed silently.
  setTimeout(() => {
    handleCheckUpdates({ silent: true });
  }, 8000);

  // Global listeners that drive the tab-header dropdown.
  document.addEventListener("click", handleDocumentClickForDropdown);
  document.addEventListener("keydown", handleTabDropdownKey);

  // Cmd/Ctrl + 1..9 → jump to that tab. (Ctrl+Tab / Ctrl+Shift+Tab /
  // Cmd-Ctrl+W are wired as native menu accelerators on the Rust side.)
  document.addEventListener("keydown", handleTabNumericNavKey);

  // Arrow-key tab nav: Ctrl/Cmd + Alt + Left/Right and Ctrl + PageUp/Down.
  document.addEventListener("keydown", handleTabArrowNavKey);

  // Window-close guard. Intercepts X button / Cmd+Q / File→Quit so dirty
  // tabs get a confirmation prompt before the window goes away.
  try {
    unlistenClose = await getCurrentWindow().onCloseRequested(
      handleCloseRequested
    );
  } catch (err) {
    console.warn("[close-guard] could not register:", err);
  }

  try {
    unlistenMenu = await listen("menu", (event) => {
      switch (event.payload) {
        case "quit":
          // Run the guard manually (same code path the X button hits),
          // so dirty tabs get the confirm modal. handleCloseRequested
          // calls actuallyExit() when the user approves.
          handleCloseRequested({ preventDefault() {} });
          return;
        case "check_updates":
          return handleCheckUpdates({ silent: false });
        case "next_tab":
          return cycleTab(1);
        case "prev_tab":
          return cycleTab(-1);
        case "close_tab":
          return closeActiveTab();
        case "new":
          return handleNew();
        case "open":
          return handleOpen();
        case "save":
          return handleSave();
        case "save_as":
          return handleSaveAs();
        case "terminal":
          return handleTerminal();
        case "file_explorer":
          return handleFileExplorer();
        case "ai_assist":
          return handleAiAssist();
        case "ai_settings":
          return openAiSettings();
        case "find":
          return handleFind();
        case "replace":
          return handleReplace();
        case "goto_line":
          return handleGotoLine();
        case "format_document":
          return handleFormatDocument();
        case "format_selection":
          return handleFormatSelection();
        case "select_all":
          return handleSelectAll();
        case "save_snippet":
          return handleSaveSnippet();
        case "snippets":
          return openSnippetsDialog();
        case "quick_actions":
          return openActionsDialog();
      }
    });
  } catch (err) {
    console.warn("Tauri event bridge not available:", err);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleDocumentClickForDropdown);
  document.removeEventListener("keydown", handleTabDropdownKey);
  document.removeEventListener("keydown", handleTabNumericNavKey);
  document.removeEventListener("keydown", handleTabArrowNavKey);
  if (unlistenClose) unlistenClose();
  // Cancel any pending draft writes so they don't run after the component
  // is gone.
  for (const t of draftTimers.values()) clearTimeout(t);
  draftTimers.clear();
  disposeEditor2();
  if (unlistenMenu) unlistenMenu();
  // Dispose editor tab models (terminal tabs clean themselves up).
  tabs.value.forEach((t) => {
    if (t.kind === "editor") t.model.dispose();
  });
  if (editor) editor.dispose();
});

function toggleTheme() {
  theme.value = theme.value === "vs-dark" ? "vs" : "vs-dark";
}

function getTabs() {
  return tabs.value;
}

// Returns the Lucide component to render for a given tab. Used by both the
// tab header trigger and the dropdown list so they stay consistent.
// ---------------------------------------------------------------------------
// Tab navigation shortcuts
// ---------------------------------------------------------------------------
//
// Three keyboard / menu paths to move between tabs:
//   Ctrl+Tab           → next tab (wraps)
//   Ctrl+Shift+Tab     → previous tab (wraps)
//   Cmd/Ctrl+W         → close the active tab
//   Cmd/Ctrl+1..9      → jump to the Nth tab (1-indexed, no menu item —
//                        9 entries would clutter the menu for no gain)
//
// The first three are wired as Tauri menu items with accelerators so they
// show up under File and the OS handles dispatch. The numeric jumps run
// through a regular document keydown listener.

function cycleTab(direction) {
  const list = tabs.value;
  if (list.length < 2) return;
  const currentIdx = list.findIndex((t) => t.id === activeTabId.value);
  // If nothing is currently active, treat -1 → first / last sensibly.
  const base = currentIdx === -1 ? 0 : currentIdx;
  const nextIdx = (base + direction + list.length) % list.length;
  activateTab(list[nextIdx].id);
}

function closeActiveTab() {
  if (activeTabId.value !== null) closeTab(activeTabId.value);
}

// Bail out of keyboard nav if anything modal is up so we don't snatch
// keystrokes from a dialog the user is interacting with.
function isModalChromeOpen() {
  if (tabDropdownOpen.value) return true;
  if (typeof document === "undefined") return false;
  return !!document.querySelector(".modal-overlay");
}

function handleTabNumericNavKey(event) {
  // Cmd on macOS or Ctrl on Windows/Linux — but not both modifiers at once.
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey || event.shiftKey) return;
  if (!/^[1-9]$/.test(event.key)) return;
  if (isModalChromeOpen()) return;
  const list = tabs.value;
  const n = parseInt(event.key, 10);
  if (n <= list.length) {
    event.preventDefault();
    activateTab(list[n - 1].id);
  }
}

// Auxiliary arrow-key tab nav. Deliberately uses Alt (not Shift), because
// Ctrl+Shift+Left/Right is the universal "extend selection by word"
// shortcut every text input and code editor reserves — overriding it
// would make word-by-word selection impossible inside Monaco.
//
// Recognized combos:
//   Ctrl+Alt+Left / Ctrl+Alt+Right       (Chrome/Firefox tab nav on Win/Linux)
//   Cmd+Option+Left / Cmd+Option+Right   (Chrome/Firefox tab nav on macOS)
//   Ctrl+PageUp / Ctrl+PageDown          (Universal browser tab nav)
function handleTabArrowNavKey(event) {
  if (isModalChromeOpen()) return;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;

  // Ctrl+PageUp / Ctrl+PageDown — no Alt or Shift needed.
  if (!event.altKey && !event.shiftKey) {
    if (event.key === "PageUp") {
      event.preventDefault();
      cycleTab(-1);
      return;
    }
    if (event.key === "PageDown") {
      event.preventDefault();
      cycleTab(1);
      return;
    }
  }

  // Ctrl+Alt+Left/Right (Win/Linux) or Cmd+Option+Left/Right (macOS).
  if (event.altKey && !event.shiftKey) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      cycleTab(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      cycleTab(1);
      return;
    }
  }
}

// Returns "1".."9" for the corresponding tab's position in `tabs`, or ""
// for anything past the ninth (those have no keyboard shortcut, so the
// numeric badge would be misleading). The number column in the dropdown
// still reserves space when the badge is empty, so names align cleanly.
function tabNumberFor(tab) {
  if (!tab) return "";
  const idx = tabs.value.findIndex((t) => t.id === tab.id);
  if (idx < 0 || idx >= 9) return "";
  return String(idx + 1);
}

const activeTabNumber = computed(() => tabNumberFor(activeTab.value));

function iconFor(tab) {
  if (!tab) return FileText;
  if (tab.kind === "terminal") return Terminal;
  if (tab.kind === "explorer") return Folder;
  if (tab.kind === "table") return FileSpreadsheet;
  if (tab.kind === "whiteboard") return PenTool;
  if (tab.kind === "preview") {
    if (tab.format === "pdf") return FileSignature;
    return ImageIcon;
  }
  if (tab.kind === "editor") {
    if (tab.language === "http") return Webhook;
    if (tab.language === "markdown") return FileText;
    if (tab.language === "json") return FileJson;
    return FileText;
  }
  return FileText;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

// The bottom status bar shows the active tab's path (or a sensible
// equivalent for terminal/explorer tabs), a copy button, and — for editor
// tabs — a dropdown that re-tags the model's language. Monaco's language
// registry is populated by everything we've registered (built-ins plus our
// custom `http` language); we list them sorted by their human-friendly
// alias.

const availableLanguages = ref([]);

function loadLanguageList() {
  try {
    availableLanguages.value = monaco.languages
      .getLanguages()
      .map((l) => ({
        id: l.id,
        label: (l.aliases && l.aliases[0]) || l.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    console.warn("[status] could not load language list:", err);
    availableLanguages.value = [];
  }
}

// What the status bar shows on the left. Editor tabs prefer the full file
// path; if the user hasn't saved yet, fall back to the display filename.
const statusPath = computed(() => {
  const t = activeTab.value;
  if (!t) return "";
  if (t.kind === "editor") return t.filePath || t.filename;
  if (t.kind === "terminal") return t.filename;
  if (t.kind === "explorer") return t.folderPath;
  return "";
});

const statusLanguage = computed(() =>
  activeTab.value?.kind === "editor" ? activeTab.value.language : ""
);

async function copyStatusPath() {
  if (!statusPath.value) return;
  try {
    await navigator.clipboard.writeText(statusPath.value);
    flashStatus("Path copied to clipboard");
  } catch (err) {
    flashStatus(`Copy failed: ${err}`);
  }
}

// Re-tag the active editor tab's model language. We don't rename the file
// — extension stays as-is — only the syntax highlighting changes. Markdown
// preview + spell check follow the new language naturally.
function changeLanguage(newLangId) {
  const tab = activeTab.value;
  if (!tab || tab.kind !== "editor") return;
  if (!newLangId || newLangId === tab.language) return;
  monaco.editor.setModelLanguage(tab.model, newLangId);
  tab.language = newLangId;
  refreshTabsList();
  // Spell check + preview re-key off `tab.language`.
  clearSpellMarkers(tab);
  scheduleSpellCheck(tab);
  if (isMarkdownActive.value) updatePreviewNow();
  else previewHtml.value = "";
  flashStatus(`Language: ${newLangId}`);
}

// ---------------------------------------------------------------------------
// Tab header dropdown (type-and-search picker)
// ---------------------------------------------------------------------------
//
// The horizontal tab strip is replaced with a dropdown:
//   - A trigger button shows the active tab's icon + name + a total count.
//   - The "+" button still lives in the header so new tabs are one click.
//   - Clicking the trigger opens a panel with a search input and a
//     filtered list of all tabs (each with a close button).
//   - Up/Down/Enter/Escape work as keyboard shortcuts while the panel is
//     open; clicks elsewhere on the page dismiss it.

const tabDropdownOpen = ref(false);
const tabSearchQuery = ref("");
const tabSelectedIndex = ref(0);
const tabSearchInput = ref(null);
const tabDropdownPanel = ref(null);
const tabTriggerEl = ref(null);

const filteredTabs = computed(() => {
  const q = tabSearchQuery.value.trim().toLowerCase();
  if (!q) return tabs.value;
  return tabs.value.filter((t) =>
    (t.filename || "").toLowerCase().includes(q)
  );
});

// Reset the keyboard cursor when the filter changes, and clamp it if items
// get removed underneath us (e.g. via close-from-dropdown).
watch([tabSearchQuery, filteredTabs], () => {
  const len = filteredTabs.value.length;
  if (tabSelectedIndex.value >= len) {
    tabSelectedIndex.value = Math.max(0, len - 1);
  }
});

function openTabDropdown() {
  tabDropdownOpen.value = true;
  tabSearchQuery.value = "";
  tabSelectedIndex.value = 0;
  nextTick(() => {
    if (tabSearchInput.value) tabSearchInput.value.focus();
  });
}

function closeTabDropdown() {
  tabDropdownOpen.value = false;
}

function toggleTabDropdown() {
  if (tabDropdownOpen.value) closeTabDropdown();
  else openTabDropdown();
}

function selectTabFromDropdown(tabId) {
  activateTab(tabId);
  closeTabDropdown();
}

function closeTabFromDropdown(tabId, event) {
  closeTab(tabId, event);
  // If the last tab just went away, drop the dropdown too — there's nothing
  // left to pick.
  if (tabs.value.length === 0) closeTabDropdown();
}

function scrollSelectedIntoView() {
  nextTick(() => {
    if (!tabDropdownPanel.value) return;
    const items = tabDropdownPanel.value.querySelectorAll(".tab-item");
    const el = items[tabSelectedIndex.value];
    if (el) el.scrollIntoView({ block: "nearest" });
  });
}

function handleTabDropdownKey(event) {
  if (!tabDropdownOpen.value) return;
  const list = filteredTabs.value;
  if (event.key === "Escape") {
    event.preventDefault();
    closeTabDropdown();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (list.length === 0) return;
    tabSelectedIndex.value = (tabSelectedIndex.value + 1) % list.length;
    scrollSelectedIntoView();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (list.length === 0) return;
    tabSelectedIndex.value =
      (tabSelectedIndex.value - 1 + list.length) % list.length;
    scrollSelectedIntoView();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const t = list[tabSelectedIndex.value];
    if (t) selectTabFromDropdown(t.id);
  }
}

function handleDocumentClickForDropdown(event) {
  if (!tabDropdownOpen.value) return;
  // Trigger clicks are handled by its own toggle; bail before checking
  // containment so the trigger's click doesn't immediately close us.
  if (tabTriggerEl.value && tabTriggerEl.value.contains(event.target)) return;
  if (
    tabDropdownPanel.value &&
    tabDropdownPanel.value.contains(event.target)
  )
    return;
  closeTabDropdown();
}
</script>

<template>
  <div class="editor-shell">
    <!-- Toolbar: same actions as the native menu, plus a Terminal shortcut.
         Each button is now icon-only with a tooltip via `title`. -->
    <div class="toolbar">
      <button class="tb-btn" @click="handleNew" title="New (Ctrl/Cmd+N)">
        <FilePlus :size="14" />
      </button>
      <button class="tb-btn" @click="handleOpen" title="Open (Ctrl/Cmd+O)">
        <FolderOpen :size="14" />
      </button>
      <button class="tb-btn" @click="handleSave" title="Save (Ctrl/Cmd+S)">
        <Save :size="14" />
      </button>
      <button
        class="tb-btn"
        @click="handleSaveAs"
        title="Save As (Ctrl/Cmd+Shift+S)"
      ><FileDown :size="14" /></button>
      <button
        class="tb-btn tb-term"
        @click="handleTerminal"
        title="Open Terminal (Ctrl/Cmd+T)"
      ><SquareTerminal :size="14" /></button>
      <button
        class="tb-btn tb-explore"
        @click="handleFileExplorer"
        title="Open File Explorer (Ctrl/Cmd+Shift+E)"
      ><FolderTree :size="14" /></button>
      <button
        class="tb-btn tb-whiteboard"
        @click="handleNewWhiteboard"
        title="New Whiteboard"
      ><Brush :size="14" /></button>
      <button
        class="tb-btn tb-ai"
        @click="handleAiAssist"
        title="AI Assist on selected text (Ctrl/Cmd+Shift+A)"
      ><Sparkles :size="14" /></button>
      <button
        v-if="canSendRequest"
        class="tb-btn tb-send"
        @click="handleSendRequest"
        title="Send the .http request at the cursor"
      ><Send :size="14" /></button>
      <button
        class="tb-btn tb-format"
        @click="handleFormatDocument"
        title="Format document (Shift+Alt+F)"
      ><WandSparkles :size="14" /></button>
      <button
        class="tb-btn tb-spell"
        :class="{ 'tb-spell-on': spellCheckEnabled }"
        @click="toggleSpellCheck"
        :title="`Spell check ${spellCheckEnabled ? 'on' : 'off'} (markdown & plaintext)`"
      ><SpellCheck :size="14" /></button>
      <button
        class="tb-btn tb-snippet"
        @click="handleSaveSnippet"
        title="Save selection as snippet"
      ><BookmarkPlus :size="14" /></button>
      <button
        class="tb-btn tb-snippet"
        @click="openSnippetsDialog"
        title="Snippets library — pick one to insert at the cursor"
      ><Bookmark :size="14" /></button>
      <button
        class="tb-btn tb-action"
        @click="openActionsDialog"
        title="Quick Actions — run a saved command in a new terminal"
      ><Zap :size="14" /></button>
      <button
        class="tb-btn tb-split"
        :class="{ 'tb-split-on': splitView }"
        @click="toggleSplitView"
        :title="splitView ? 'Close split view' : 'Open split view (two editor panels)'"
      ><Columns2 :size="14" /></button>
      <button
        v-if="isMarkdownActive"
        class="tb-btn tb-preview"
        :class="{ 'tb-preview-on': showPreview }"
        @click="togglePreview"
        :title="`Markdown preview ${showPreview ? 'on' : 'off'}`"
      >
        <component :is="showPreview ? Eye : EyeOff" :size="14" />
      </button>
      <div class="status" :class="{ show: statusMsg }">{{ statusMsg }}</div>
      <button
        class="theme-toggle"
        @click="toggleTheme"
        :title="`Switch to ${theme === 'vs-dark' ? 'light' : 'dark'} theme`"
      >
        <component :is="theme === 'vs-dark' ? Sun : Moon" :size="14" />
      </button>
    </div>

    <!--
      Tab header: a dropdown trigger that shows the currently-active tab and
      opens a searchable list of every open tab. The "+" button to the right
      keeps "create a new tab" one click away even when the dropdown is shut.
    -->
    <div class="tab-header">
      <button
        ref="tabTriggerEl"
        class="tab-trigger"
        :class="{ open: tabDropdownOpen }"
        @click.stop="toggleTabDropdown"
      >
        <component
          v-if="activeTab"
          :is="iconFor(activeTab)"
          :size="14"
          class="trigger-icon"
        />
        <span
          v-if="activeTabNumber"
          class="trigger-num"
          :title="`Cmd/Ctrl + ${activeTabNumber}`"
        >{{ activeTabNumber }}</span>
        <span class="trigger-name">
          {{ activeTab ? activeTab.filename : "No tab open" }}
          <span v-if="activeTab && activeTab.dirty" class="dot">●</span>
        </span>
        <span class="trigger-count" v-if="tabs.length">{{ tabs.length }}</span>
        <component
          :is="tabDropdownOpen ? ChevronUp : ChevronDown"
          :size="12"
          class="trigger-caret"
        />
      </button>
      <button class="tab-add" @click="addEditorTab()" title="New tab">
        <Plus :size="16" />
      </button>

      <div
        v-if="tabDropdownOpen"
        ref="tabDropdownPanel"
        class="tab-dropdown"
        @click.stop
      >
        <input
          ref="tabSearchInput"
          v-model="tabSearchQuery"
          type="text"
          placeholder="Type to search tabs…"
          class="tab-search"
        />
        <div class="tab-dropdown-list">
          <div v-if="filteredTabs.length === 0" class="tab-empty">
            No tabs match
          </div>
          <template v-else>
            <div
              v-for="(tab, idx) in filteredTabs"
              :key="tab.id"
              class="tab-item"
              :class="{
                active: tab.id === activeTabId,
                selected: idx === tabSelectedIndex,
                terminal: tab.kind === 'terminal',
                explorer: tab.kind === 'explorer',
                table: tab.kind === 'table',
                whiteboard: tab.kind === 'whiteboard',
                preview: tab.kind === 'preview',
              }"
              @click="selectTabFromDropdown(tab.id)"
              @dblclick.stop="renameTab(tab)"
              :title="tab.filePath || tab.folderPath || tab.filename"
            >
              <span
                class="item-num"
                :title="
                  tabNumberFor(tab)
                    ? `Cmd/Ctrl + ${tabNumberFor(tab)}`
                    : ''
                "
              >{{ tabNumberFor(tab) }}</span>
              <component
                :is="iconFor(tab)"
                :size="14"
                class="item-icon"
              />
              <span class="item-name">
                {{ tab.filename }}<span v-if="tab.dirty" class="dot">●</span>
              </span>
              <button
                class="item-close"
                @click.stop="closeTabFromDropdown(tab.id, $event)"
                aria-label="Close tab"
                title="Close tab"
              ><X :size="13" /></button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Content area: Monaco lives here at all times; terminals are layered
         on top, each one shown only when its tab is active. -->
    <div class="content-area">
      <div
        ref="editorContainer"
        class="editor-host"
        :class="{
          'with-preview': showPreviewActive,
          'with-split': splitView,
        }"
        v-show="isEditorActive"
      ></div>

      <!--
        Markdown preview pane. Lives at the right half of the content area
        when an .md tab is active and the user hasn't toggled preview off.
        `v-html` consumes markdown-it's escaped output (html: false in the
        renderer config means raw HTML in the source is dropped).
      -->
      <div
        v-show="showPreviewActive"
        ref="previewPaneEl"
        class="md-preview"
        v-html="previewHtml"
      ></div>

      <!--
        Split-view right pane. Independent Monaco instance that views any
        editor tab the user picks from the selector. Same model can show in
        both panes — Monaco syncs edits between them.
      -->
      <div v-if="splitView" class="right-panel">
        <div class="right-panel-header">
          <Columns2 :size="13" class="rp-label" />
          <select
            class="rp-select"
            :value="rightPanelTabId ?? ''"
            @change="setRightPanelTab($event.target.value)"
            title="Tab to view in the right pane"
          >
            <option value="">— pick a tab —</option>
            <option
              v-for="t in editorTabs"
              :key="t.id"
              :value="t.id"
            >{{ t.filename }}</option>
          </select>
          <button
            class="rp-close"
            @click="closeSplitView"
            title="Close split view"
          ><X :size="14" /></button>
        </div>
        <div ref="editor2Container" class="editor-host-right"></div>
      </div>

      <div
        v-for="tab in terminalTabs"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        class="terminal-wrap"
      >
        <TerminalTab
          :active="tab.id === activeTabId"
          :initial-command="tab.initialCommand || ''"
          @exit="onTerminalExit(tab.id)"
        />
      </div>

      <!--
        Explorer tabs are kept mounted via v-for + v-show so navigation
        state (current path, scroll position) survives switching away.
        Clicking a file emits `open-file`, which we hand to the parent's
        openFileFromExplorer().
      -->
      <div
        v-for="tab in explorerTabs"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        class="explorer-wrap"
      >
        <FileExplorerTab
          :initial-path="tab.folderPath"
          :active="tab.id === activeTabId"
          @open-file="openFileFromExplorer"
        />
      </div>

      <!--
        Table tabs (CSV / XLSX). Each renders a Tabulator instance and
        stays mounted across tab switches via v-show. The function ref
        keeps a per-tab handle so the parent can call `serialize()` at
        save time.
      -->
      <div
        v-for="tab in tableTabsList"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        class="table-wrap"
      >
        <TableTab
          :ref="(el) => { if (el) tableRefs[tab.id] = el; }"
          :tab="tab"
          :active="tab.id === activeTabId"
          @dirty-changed="(d) => { tab.dirty = d; refreshTabsList(); if (d) scheduleDraftSave(tab); }"
        />
      </div>

      <!--
        Whiteboard tabs (Fabric.js canvas). Kept mounted via v-show so the
        drawing state survives tab switches; the function ref keeps a
        per-tab handle for the parent's save flow.
      -->
      <div
        v-for="tab in whiteboardTabsList"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        class="whiteboard-wrap"
      >
        <WhiteboardTab
          :ref="(el) => { if (el) whiteboardRefs[tab.id] = el; }"
          :tab="tab"
          :active="tab.id === activeTabId"
          @dirty-changed="(d) => { tab.dirty = d; refreshTabsList(); if (d) scheduleDraftSave(tab); }"
        />
      </div>

      <!--
        Image / SVG / PDF preview tabs. Read-only — no refs needed, no
        dirty tracking; the component manages its own object-URL lifecycle.
      -->
      <div
        v-for="tab in previewTabsList"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        class="preview-wrap"
      >
        <PreviewTab
          :tab="tab"
          :active="tab.id === activeTabId"
        />
      </div>

      <div v-if="getTabs().length === 0" class="empty-state">
        No tabs open. Use <strong>File → New</strong> or
        <strong>Tools → Terminal</strong>.
      </div>
    </div>

    <!-- Bottom status bar -->
    <div class="status-bar">
      <div class="status-left">
        <span class="status-path" :title="statusPath">
          {{ statusPath || "No active tab" }}
        </span>
        <button
          v-if="statusPath"
          class="status-copy"
          @click="copyStatusPath"
          title="Copy path to clipboard"
          aria-label="Copy path"
        ><Copy :size="13" /></button>
      </div>
      <div class="status-right">
        <template v-if="activeTab && activeTab.kind === 'editor'">
          <span class="status-label">Syntax</span>
          <select
            class="status-lang"
            :value="statusLanguage"
            @change="changeLanguage($event.target.value)"
            title="Change syntax for this tab"
          >
            <option
              v-for="lang in availableLanguages"
              :key="lang.id"
              :value="lang.id"
            >{{ lang.label }}</option>
          </select>
        </template>
        <span
          v-else-if="activeTab"
          class="status-kind"
        >{{ activeTab.kind }}</span>
      </div>
    </div>

    <!-- ============================================================
         AI Assist modal — appears when the user invokes AI on a
         non-empty selection.
         ============================================================ -->
    <div
      v-if="aiDialogOpen"
      class="modal-overlay"
      @click.self="closeAiDialog"
    >
      <div class="modal">
        <div class="modal-header">
          <h3>AI Assist</h3>
          <button
            class="modal-close"
            @click="closeAiDialog"
            :disabled="aiLoading"
            title="Close"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <div class="selected-preview">
            <div class="preview-label">Selected text</div>
            <pre>{{
              aiSelectedText.length > 600
                ? aiSelectedText.slice(0, 600) + "…"
                : aiSelectedText
            }}</pre>
          </div>
          <label>What would you like to do with this?</label>
          <textarea
            ref="aiPromptInput"
            v-model="aiPrompt"
            rows="4"
            placeholder="e.g. Summarize this · Refactor for clarity · Translate to Spanish · Explain step by step"
            @keydown.meta.enter="runAiAssist"
            @keydown.ctrl.enter="runAiAssist"
          ></textarea>
          <div v-if="aiError" class="ai-error">{{ aiError }}</div>
        </div>
        <div class="modal-footer">
          <button @click="closeAiDialog" :disabled="aiLoading">Cancel</button>
          <button
            class="primary"
            @click="runAiAssist"
            :disabled="!aiPrompt.trim() || aiLoading"
          >{{ aiLoading ? "Working…" : "Run" }}</button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         AI Settings modal — provider, API key, model, system prompt.
         ============================================================ -->
    <div
      v-if="aiSettingsOpen"
      class="modal-overlay"
      @click.self="closeAiSettings"
    >
      <div class="modal">
        <div class="modal-header">
          <h3>AI Settings</h3>
          <button
            class="modal-close"
            @click="closeAiSettings"
            title="Close"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <label>Provider</label>
          <select v-model="aiConfigDraft.provider">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>

          <label>API Key</label>
          <input
            type="password"
            v-model="aiConfigDraft.apiKey"
            :placeholder="
              aiConfigDraft.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'
            "
            autocomplete="off"
          />
          <div class="hint">
            Stored locally in your browser storage. Never sent anywhere
            except to the provider you select above.
          </div>

          <label>Model</label>
          <input
            v-if="aiConfigDraft.provider === 'openai'"
            type="text"
            v-model="aiConfigDraft.openaiModel"
            placeholder="gpt-4o-mini"
          />
          <input
            v-else
            type="text"
            v-model="aiConfigDraft.anthropicModel"
            placeholder="claude-3-5-sonnet-latest"
          />

          <label>System Prompt</label>
          <textarea v-model="aiConfigDraft.systemPrompt" rows="4"></textarea>

          <label>Max tokens</label>
          <input
            type="number"
            min="64"
            max="8192"
            step="64"
            v-model.number="aiConfigDraft.maxTokens"
          />
        </div>
        <div class="modal-footer">
          <button @click="closeAiSettings">Cancel</button>
          <button class="primary" @click="saveAiSettings">Save</button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         Save Snippet — captures the current selection.
         ============================================================ -->
    <div
      v-if="saveSnippetDialogOpen"
      class="modal-overlay"
      @click.self="saveSnippetDialogOpen = false"
    >
      <div class="modal">
        <div class="modal-header">
          <h3>Save Snippet</h3>
          <button
            class="modal-close"
            @click="saveSnippetDialogOpen = false"
            title="Close"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <label>Type</label>
          <div class="action-type-toggle">
            <label class="action-type-option">
              <input
                type="radio"
                v-model="snippetDraft.type"
                value="text"
              />
              <span>Text snippet — pastes content at the cursor</span>
            </label>
            <label class="action-type-option">
              <input
                type="radio"
                v-model="snippetDraft.type"
                value="prompt"
              />
              <span>Prompt snippet — runs as an AI prompt</span>
            </label>
          </div>

          <label>Name</label>
          <input
            ref="snippetNameInput"
            v-model="snippetDraft.name"
            :placeholder="
              snippetDraft.type === 'prompt'
                ? 'e.g. Refactor for clarity, Add docstrings'
                : 'e.g. for-loop, json-template, license-header'
            "
            @keydown.enter.prevent="commitSaveSnippet"
          />

          <label>Description (optional)</label>
          <input
            v-model="snippetDraft.description"
            placeholder="What's this snippet for?"
          />

          <template v-if="snippetDraft.type === 'prompt'">
            <label>Prompt instruction</label>
            <textarea
              v-model="snippetDraft.content"
              rows="5"
              placeholder="e.g. Rewrite this paragraph more concisely · Translate to Spanish · Add type annotations to this function"
            ></textarea>
            <div class="action-vars-hint">
              When run, the editor's current selection (if any) is sent
              alongside this instruction. The AI's reply replaces the
              selection — or is inserted at the cursor if nothing's
              selected.
            </div>
          </template>
          <template v-else>
            <label>Content</label>
            <textarea
              v-model="snippetDraft.content"
              rows="8"
              class="snippet-content-input"
              placeholder="Paste or type the snippet text…"
            ></textarea>
          </template>
        </div>
        <div class="modal-footer">
          <button @click="saveSnippetDialogOpen = false">Cancel</button>
          <button
            class="primary"
            @click="commitSaveSnippet"
            :disabled="
              !snippetDraft.name.trim() || !snippetDraft.content.trim()
            "
          >Save</button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         Snippets library — search + click to insert + delete.
         ============================================================ -->
    <div
      v-if="snippetsDialogOpen"
      class="modal-overlay"
      @click.self="snippetsDialogOpen = false"
    >
      <div class="modal modal-snippets">
        <div class="modal-header">
          <h3>Snippets ({{ snippetsList.length }})</h3>
          <button
            class="modal-close"
            @click="snippetsDialogOpen = false"
            title="Close"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <div class="action-toolbar-row">
            <input
              ref="snippetSearchInput"
              v-model="snippetSearchQuery"
              type="text"
              placeholder="Search snippets by name, description, or content…"
              class="snippet-search action-search"
            />
            <button
              class="action-new-btn"
              @click="openNewSnippetDialog"
              title="Create a new snippet"
            ><Plus :size="13" /> New</button>
          </div>
          <div class="snippet-list">
            <div
              v-if="filteredSnippets.length === 0"
              class="snippet-empty"
            >
              <template v-if="snippetsList.length === 0">
                No snippets yet. Select text and click the bookmark+ icon
                to save a text snippet, or click <strong>+ New</strong> to
                create a prompt snippet that runs through AI.
              </template>
              <template v-else>No snippets match your search.</template>
            </div>
            <div
              v-for="s in filteredSnippets"
              :key="s.id"
              class="snippet-item"
            >
              <div class="snippet-body" @click="pickSnippet(s)">
                <div class="snippet-row-top">
                  <span class="snippet-name">{{ s.name }}</span>
                  <span
                    class="action-type-pill"
                    :class="
                      (s.type || 'text') === 'prompt'
                        ? 'action-type-prompt'
                        : 'action-type-text'
                    "
                  >{{ (s.type || "text") === "prompt" ? "prompt" : "text" }}</span>
                  <span v-if="s.language" class="snippet-lang">{{ s.language }}</span>
                  <span class="action-run-hint">{{
                    (s.type || "text") === "prompt" ? "▶ run" : "▶ insert"
                  }}</span>
                </div>
                <div
                  v-if="s.description"
                  class="snippet-desc"
                >{{ s.description }}</div>
                <pre class="snippet-content">{{
                  s.content.length > 240
                    ? s.content.slice(0, 240) + "…"
                    : s.content
                }}</pre>
              </div>
              <button
                class="snippet-delete"
                @click.stop="removeSnippet(s.id, $event)"
                title="Delete snippet"
                aria-label="Delete snippet"
              ><Trash2 :size="14" /></button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button @click="snippetsDialogOpen = false">Close</button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         Quick Actions library — list + search + new/run/delete.
         Clicking a row spawns a terminal tab that runs the action's
         command with template variables substituted from the active
         editor tab and selection.
         ============================================================ -->
    <div
      v-if="actionsDialogOpen"
      class="modal-overlay"
      @click.self="actionsDialogOpen = false"
    >
      <div class="modal modal-snippets">
        <div class="modal-header">
          <h3>Quick Actions ({{ actionsList.length }})</h3>
          <button
            class="modal-close"
            @click="actionsDialogOpen = false"
            title="Close"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <div class="action-toolbar-row">
            <input
              ref="actionSearchInput"
              v-model="actionSearchQuery"
              type="text"
              placeholder="Search actions by name, description, or command…"
              class="snippet-search action-search"
            />
            <button
              class="action-new-btn"
              @click="openNewActionDialog"
              title="Create a new action"
            ><Plus :size="13" /> New</button>
          </div>
          <div class="action-vars-hint">
            Available templates:
            <code>{file}</code> · <code>{dir}</code> ·
            <code>{filename}</code> · <code>{basename}</code> ·
            <code>{ext}</code> · <code>{selection}</code>
          </div>
          <div class="snippet-list">
            <div
              v-if="filteredActions.length === 0"
              class="snippet-empty"
            >
              <template v-if="actionsList.length === 0">
                No actions yet. Click <strong>+ New</strong> above —
                shell commands run in a new terminal, Python scripts
                read stdin and replace your selection with stdout.
              </template>
              <template v-else>No actions match your search.</template>
            </div>
            <div
              v-for="a in filteredActions"
              :key="a.id"
              class="snippet-item"
            >
              <div class="snippet-body" @click="runAction(a)">
                <div class="snippet-row-top">
                  <span class="snippet-name">{{ a.name }}</span>
                  <span
                    class="action-type-pill"
                    :class="`action-type-${a.type || 'shell'}`"
                  >{{ (a.type || "shell") === "python" ? "py" : "sh" }}</span>
                  <span class="action-run-hint">▶ run</span>
                </div>
                <div
                  v-if="a.description"
                  class="snippet-desc"
                >{{ a.description }}</div>
                <pre class="snippet-content">{{
                  (a.type || "shell") === "python"
                    ? `python ${a.scriptPath}${a.args ? ' ' + a.args : ''}`
                    : a.command
                }}</pre>
              </div>
              <button
                class="snippet-delete"
                @click.stop="removeAction(a.id, $event)"
                title="Delete action"
                aria-label="Delete action"
              ><Trash2 :size="14" /></button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button @click="actionsDialogOpen = false">Close</button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         Auto-update prompt. Triggered either by the startup check
         (silent — only shows on hit) or by File → Check for Updates….
         ============================================================ -->
    <div
      v-if="updateDialogOpen"
      class="modal-overlay"
      @click.self="dismissUpdate"
    >
      <div class="modal">
        <div class="modal-header">
          <h3>
            <Download :size="15" class="close-warn-icon" />
            Update available
          </h3>
          <button
            v-if="!updateInstalling"
            class="modal-close"
            @click="dismissUpdate"
            title="Remind me later"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <p class="close-summary">
            Sparrow {{ pendingUpdate?.version }} is available
            <span v-if="pendingUpdate?.currentVersion">
              (you're running {{ pendingUpdate.currentVersion }})
            </span>.
          </p>
          <div v-if="pendingUpdate?.body" class="update-notes">{{ pendingUpdate.body }}</div>
          <div v-if="updateInstalling" class="update-progress-wrap">
            <div class="update-progress-bar">
              <div
                class="update-progress-fill"
                :style="{ width: `${Math.round(updateProgress * 100)}%` }"
              ></div>
            </div>
            <div class="update-progress-label">
              {{
                updateProgress >= 1
                  ? "Applying update — relaunching…"
                  : `Downloading… ${Math.round(updateProgress * 100)}%`
              }}
            </div>
          </div>
        </div>
        <div class="modal-footer" v-if="!updateInstalling">
          <button @click="dismissUpdate">Remind Me Later</button>
          <button class="primary" @click="confirmInstallUpdate">
            Install &amp; Relaunch
          </button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         Draft recovery — shown on startup if any drafts were left in
         $APPLOCALDATA/drafts/ from a previous session.
         ============================================================ -->
    <div v-if="recoveryDialogOpen" class="modal-overlay">
      <div class="modal modal-snippets">
        <div class="modal-header">
          <h3>
            <History :size="15" class="close-warn-icon" />
            Recover unsaved drafts
          </h3>
        </div>
        <div class="modal-body">
          <p class="close-summary">
            Sparrow found {{ draftsToRecover.length }} unsaved
            draft{{ draftsToRecover.length === 1 ? "" : "s" }} from a
            previous session.
          </p>
          <ul class="recovery-list">
            <li
              v-for="d in draftsToRecover"
              :key="d.draftKey"
              class="recovery-item"
            >
              <component
                :is="iconForDraft(d)"
                :size="14"
                class="recovery-item-icon"
              />
              <div class="recovery-info">
                <div class="recovery-row-top">
                  <span class="recovery-name">{{ d.filename }}</span>
                  <span class="recovery-time">
                    {{ formatRelativeTime(d.savedAt) }}
                  </span>
                </div>
                <div v-if="d.filePath" class="recovery-path">
                  {{ d.filePath }}
                </div>
                <div v-else class="recovery-untitled">
                  untitled — was never saved to disk
                </div>
              </div>
              <button
                class="recovery-action"
                @click="restoreDraft(d)"
                title="Restore as a new tab"
              >Restore</button>
              <button
                class="recovery-action recovery-danger"
                @click="discardDraft(d)"
                title="Delete this draft"
                aria-label="Discard draft"
              ><Trash2 :size="13" /></button>
            </li>
          </ul>
        </div>
        <div class="modal-footer">
          <button class="danger" @click="discardAllDrafts">
            Discard All
          </button>
          <button class="primary" @click="restoreAllDrafts">
            Restore All
          </button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         Window-close confirmation. Listed dirty tabs are split by
         whether they have a file path (savable) vs untitled (will
         be lost). Save All only acts on the savable ones.
         ============================================================ -->
    <div
      v-if="closeConfirmOpen"
      class="modal-overlay"
      @click.self="cancelClose"
    >
      <div class="modal">
        <div class="modal-header">
          <h3>
            <AlertTriangle :size="15" class="close-warn-icon" />
            Unsaved changes
          </h3>
          <button class="modal-close" @click="cancelClose" title="Cancel">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <p class="close-summary">
            {{ dirtyTabsBeforeClose.length }} tab(s) have unsaved changes.
            What would you like to do?
          </p>
          <ul class="close-dirty-list">
            <li
              v-for="t in dirtyTabsBeforeClose"
              :key="t.id"
              :class="{ 'close-unsavable': !t.filePath }"
            >
              <component
                :is="iconFor(t)"
                :size="13"
                class="close-dirty-icon"
              />
              <span class="close-dirty-name">{{ t.filename }}</span>
              <span v-if="!t.filePath" class="close-dirty-warn">
                untitled — won't be saved
              </span>
              <span v-else class="close-dirty-path">{{ t.filePath }}</span>
            </li>
          </ul>
        </div>
        <div class="modal-footer">
          <button @click="cancelClose">Cancel</button>
          <button class="danger" @click="discardAndClose">
            Discard &amp; Quit
          </button>
          <button class="primary" @click="saveAllAndClose">
            Save All &amp; Quit
          </button>
        </div>
      </div>
    </div>

    <!-- ============================================================
         New Action — name + command + description.
         ============================================================ -->
    <div
      v-if="newActionDialogOpen"
      class="modal-overlay"
      @click.self="newActionDialogOpen = false"
    >
      <div class="modal">
        <div class="modal-header">
          <h3>New Action</h3>
          <button
            class="modal-close"
            @click="newActionDialogOpen = false"
            title="Close"
          ><X :size="16" /></button>
        </div>
        <div class="modal-body">
          <label>Type</label>
          <div class="action-type-toggle">
            <label class="action-type-option">
              <input
                type="radio"
                v-model="actionDraft.type"
                value="shell"
              />
              <span>Shell command — runs in a new terminal</span>
            </label>
            <label class="action-type-option">
              <input
                type="radio"
                v-model="actionDraft.type"
                value="python"
              />
              <span>Python script — replaces selection with stdout</span>
            </label>
          </div>

          <label>Name</label>
          <input
            ref="actionNameInput"
            v-model="actionDraft.name"
            placeholder="e.g. Run tests, Format JSON, Uppercase selection"
          />

          <template v-if="actionDraft.type === 'shell'">
            <label>Command</label>
            <textarea
              v-model="actionDraft.command"
              rows="3"
              placeholder='e.g. npm test, eslint "{file}", grep -r "{selection}" "{dir}"'
            ></textarea>
            <div class="action-vars-hint">
              Use
              <code>{file}</code>, <code>{dir}</code>,
              <code>{filename}</code>, <code>{basename}</code>,
              <code>{ext}</code>, or <code>{selection}</code> as
              placeholders. Wrap them in quotes if the path may contain
              spaces.
            </div>
          </template>

          <template v-else>
            <label>Python script (.py)</label>
            <div class="path-row">
              <input
                v-model="actionDraft.scriptPath"
                placeholder="/path/to/script.py"
              />
              <button
                type="button"
                class="path-pick-btn"
                @click="pickActionScriptPath"
                title="Browse for a .py file"
              ><FolderOpen :size="14" /> Browse</button>
            </div>

            <label>Extra args (optional)</label>
            <input
              v-model="actionDraft.args"
              placeholder='e.g. --pretty "{file}"'
            />

            <div class="action-vars-hint">
              The script gets the current selection (or whole file if
              nothing is selected) on <code>stdin</code>. Whatever it prints
              to <code>stdout</code> replaces that text in the editor.<br />
              Env vars exposed: <code>SPARROW_FILE</code>,
              <code>SPARROW_DIR</code>, <code>SPARROW_FILENAME</code>,
              <code>SPARROW_BASENAME</code>, <code>SPARROW_EXT</code>,
              <code>SPARROW_LANGUAGE</code>,
              <code>SPARROW_HAS_SELECTION</code>.<br />
              Args support the same template placeholders.
            </div>
          </template>

          <label>Description (optional)</label>
          <input
            v-model="actionDraft.description"
            placeholder="What does this action do?"
          />
        </div>
        <div class="modal-footer">
          <button @click="newActionDialogOpen = false">Cancel</button>
          <button
            class="primary"
            @click="commitNewAction"
            :disabled="
              !actionDraft.name.trim() ||
              (actionDraft.type === 'shell' &&
                !actionDraft.command.trim()) ||
              (actionDraft.type === 'python' &&
                !actionDraft.scriptPath.trim())
            "
          >Save</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  color: #d4d4d4;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #1f1f1f;
  border-bottom: 1px solid #0f0f0f;
}

.tb-btn {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  min-height: 26px;
  line-height: 0;
}

.tb-btn:hover {
  border-color: #396cd8;
  background: #333;
}

.tb-term {
  background: #21343f;
}

.tb-send {
  background: #1e3a26;
  color: #b5e8b9;
}

.tb-send:hover {
  border-color: #6cc070;
}

.tb-format {
  background: #2a3a52;
  color: #b9d1f0;
}

.tb-format:hover {
  border-color: #6c95d5;
}

.tb-spell {
  background: #2d2d2d;
  color: #c5c5c5;
}

.tb-spell-on {
  background: #1f3850;
  color: #cce4ff;
  border-color: #4287d6;
}

.tb-split {
  background: #2d2d2d;
  color: #c5c5c5;
}

.tb-split-on {
  background: #21434a;
  color: #b6e3ea;
  border-color: #4a8fa1;
}

.status {
  flex: 1;
  text-align: center;
  font-size: 12px;
  color: #888;
  opacity: 0;
  transition: opacity 0.15s;
}

.status.show {
  opacity: 1;
  color: #6cc070;
}

/* --- Tab header dropdown --- */

.tab-header {
  position: relative;
  display: flex;
  align-items: stretch;
  background: #252526;
  border-bottom: 1px solid #1e1e1e;
  min-height: 36px;
}

.tab-trigger {
  flex: 1;
  background: transparent;
  border: none;
  color: #d4d4d4;
  cursor: pointer;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  border-radius: 0;
  border-right: 1px solid #1e1e1e;
  box-shadow: none;
}

.tab-trigger:hover,
.tab-trigger.open {
  background: #2a2a2a;
  border-color: #1e1e1e;
}

.trigger-icon {
  color: #888;
  flex-shrink: 0;
}

/* Numeric badge on the trigger — shows the active tab's Cmd/Ctrl+N
   shortcut so the user always knows which number activates it. */
.trigger-num {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #aaa;
  background: #1a1a1a;
  border: 1px solid #333;
  padding: 0 5px;
  border-radius: 3px;
  min-width: 14px;
  text-align: center;
  flex-shrink: 0;
  line-height: 16px;
}

.trigger-name {
  flex: 1;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #fff;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.trigger-count {
  background: #3a3a3a;
  color: #aaa;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.trigger-caret {
  color: #888;
  flex-shrink: 0;
}

.dot {
  color: #cccccc;
  font-size: 10px;
}

.tab-add,
.theme-toggle {
  background: transparent;
  border: none;
  color: #c5c5c5;
  cursor: pointer;
  font-size: 16px;
  padding: 0 14px;
  box-shadow: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.tab-add:hover,
.theme-toggle:hover {
  background: #333;
  color: #fff;
}

.theme-toggle {
  font-size: 12px;
  padding: 0 10px;
}

.tab-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  width: 380px;
  max-width: 90vw;
  background: #252526;
  border: 1px solid #1a1a1a;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
  z-index: 100;
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  border-radius: 0 0 6px 6px;
}

.tab-search {
  background: #1e1e1e;
  color: #d4d4d4;
  border: none;
  border-bottom: 1px solid #1a1a1a;
  padding: 10px 14px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
}

.tab-search::placeholder {
  color: #777;
}

.tab-search:focus {
  background: #2a2a2a;
}

.tab-dropdown-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tab-empty {
  padding: 14px 16px;
  color: #888;
  font-size: 12px;
  text-align: center;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  color: #c5c5c5;
}

.tab-item:hover {
  background: #2a2d2e;
}

.tab-item.selected {
  background: #2a2d2e;
}

.tab-item.active {
  background: #094771;
  color: #fff;
}

.tab-item.active.selected {
  background: #0f5a8e;
}

/* Per-row tab-number badge. Empty (no number) for tabs 10+, but the
   slot keeps its fixed width so the icons line up across all rows. */
.tab-item .item-num {
  display: inline-block;
  width: 18px;
  text-align: center;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #888;
  flex-shrink: 0;
}

.tab-item.active .item-num {
  color: #cce4ff;
}

.tab-item .item-icon {
  flex-shrink: 0;
  color: #9aa1ad;
}

.tab-item.terminal .item-icon {
  color: #6cc070;
}

.tab-item.explorer .item-icon {
  color: #c89a5d;
}

.tab-item.active .item-icon {
  color: #ffffff;
}

.tab-item .item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tab-item .item-close {
  background: transparent;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 4px;
  box-shadow: none;
  opacity: 0.5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.tab-item:hover .item-close,
.tab-item.active .item-close,
.tab-item.selected .item-close {
  opacity: 1;
}

.tab-item .item-close:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.content-area {
  flex: 1;
  min-height: 0;
  position: relative;
}

.editor-host {
  position: absolute;
  inset: 0;
}

/* When the markdown preview is active, the editor takes the left half. */
.editor-host.with-preview {
  right: 50%;
  border-right: 1px solid #2a2a2a;
}

/* Split view: same layout idea — left editor takes the left half. */
.editor-host.with-split {
  right: 50%;
  border-right: 1px solid #2a2a2a;
}

.right-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  right: 0;
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
}

.right-panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: #252526;
  border-bottom: 1px solid #1a1a1a;
  flex: 0 0 auto;
  min-height: 30px;
}

.rp-label {
  color: #888;
  flex-shrink: 0;
}

.rp-select {
  flex: 1;
  background: #1e1e1e;
  color: #d4d4d4;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  min-width: 0;
}

.rp-select:hover {
  border-color: #3a3a3a;
}

.rp-select:focus {
  border-color: #4287d6;
}

.rp-close {
  background: transparent;
  border: none;
  color: #aaa;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 3px;
  box-shadow: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.rp-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.editor-host-right {
  flex: 1;
  min-height: 0;
}

.md-preview {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  right: 0;
  overflow: auto;
  padding: 18px 24px 40px 24px;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
    sans-serif;
  font-size: 14px;
  line-height: 1.6;
  box-sizing: border-box;
}

/* Minimal but presentable markdown defaults. Targets the rendered tags
   directly — markdown-it produces vanilla HTML, no extra wrapper class. */
.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3),
.md-preview :deep(h4) {
  color: #ffffff;
  margin: 1.4em 0 0.5em 0;
  line-height: 1.25;
}

.md-preview :deep(h1) {
  font-size: 1.8em;
  border-bottom: 1px solid #2e2e2e;
  padding-bottom: 0.25em;
}

.md-preview :deep(h2) {
  font-size: 1.4em;
  border-bottom: 1px solid #262626;
  padding-bottom: 0.2em;
}

.md-preview :deep(h3) {
  font-size: 1.2em;
}

.md-preview :deep(p) {
  margin: 0.6em 0;
}

.md-preview :deep(a) {
  color: #4ea1f3;
  text-decoration: none;
}

.md-preview :deep(a:hover) {
  text-decoration: underline;
}

.md-preview :deep(code) {
  background: #2d2d2d;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.9em;
}

.md-preview :deep(pre) {
  background: #161616;
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  border: 1px solid #262626;
}

.md-preview :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.9em;
}

/* highlight.js github-dark sets its own background on `.hljs`;
   override it to match Sparrow's #161616 code panel so highlighted
   blocks don't pop in a slightly different shade. */
.md-preview :deep(pre.hljs) {
  background: #161616;
}

.md-preview :deep(pre.hljs code) {
  background: transparent;
}

/* GitHub-style task lists: hide the bullet, give the checkbox the
   Sparrow blue accent, and pull the row left so it aligns with the
   surrounding paragraph text. */
.md-preview :deep(ul.contains-task-list),
.md-preview :deep(ol.contains-task-list) {
  list-style: none;
  padding-left: 0;
}

.md-preview :deep(li.task-list-item) {
  list-style: none;
  padding-left: 0;
}

.md-preview :deep(li.task-list-item input[type="checkbox"]) {
  margin-right: 8px;
  accent-color: #4287d6;
  vertical-align: -2px;
  cursor: default; /* disabled checkbox — visually we still want a default cursor not the disabled one */
}

.md-preview :deep(li.task-list-item input[type="checkbox"]:disabled) {
  opacity: 0.9;
}

/* Mermaid diagrams — center the SVG and let it scale down for narrow
   preview panes. Mermaid emits its own colors via the configured theme;
   we just frame the container. */
.md-preview :deep(div.mermaid) {
  margin: 12px 0;
  padding: 8px 10px;
  background: #161616;
  border: 1px solid #262626;
  border-radius: 6px;
  text-align: center;
  overflow-x: auto;
}

.md-preview :deep(div.mermaid svg) {
  max-width: 100%;
  height: auto;
}

.md-preview :deep(blockquote) {
  border-left: 3px solid #3a3a3a;
  padding: 0 0 0 12px;
  color: #aaaaaa;
  margin: 0.6em 0;
}

.md-preview :deep(ul),
.md-preview :deep(ol) {
  margin: 0.5em 0;
  padding-left: 24px;
}

.md-preview :deep(li) {
  margin: 0.2em 0;
}

.md-preview :deep(hr) {
  border: 0;
  border-top: 1px solid #2e2e2e;
  margin: 1.2em 0;
}

.md-preview :deep(table) {
  border-collapse: collapse;
  margin: 0.6em 0;
}

.md-preview :deep(th),
.md-preview :deep(td) {
  border: 1px solid #2e2e2e;
  padding: 6px 10px;
}

.md-preview :deep(th) {
  background: #252525;
}

.md-preview :deep(img) {
  max-width: 100%;
}

.tb-preview {
  background: #2d2d2d;
  color: #c5c5c5;
}

.tb-preview-on {
  background: #3a2a4d;
  color: #e0cdf5;
  border-color: #8a5fd1;
}

.terminal-wrap {
  position: absolute;
  inset: 0;
  background: #1e1e1e;
}

.explorer-wrap {
  position: absolute;
  inset: 0;
  background: #1e1e1e;
}

.table-wrap {
  position: absolute;
  inset: 0;
  background: #1e1e1e;
}

.whiteboard-wrap {
  position: absolute;
  inset: 0;
  background: #1e1e1e;
}

.preview-wrap {
  position: absolute;
  inset: 0;
  background: #1e1e1e;
}

.tab-item.table .item-icon {
  color: #7bc97b;
}

.tab-item.whiteboard .item-icon {
  color: #d369c7;
}

.tab-item.preview .item-icon {
  color: #5cb8c4;
}

.tb-whiteboard {
  background: #3d2740;
  color: #f0c0e8;
}

.tb-whiteboard:hover {
  border-color: #d369c7;
}

.tb-explore {
  background: #3a2f1f;
  color: #f5d9b0;
}

.tb-explore:hover {
  border-color: #c89a5d;
}

.tb-ai {
  background: #2f243d;
  color: #d4c5f0;
}

.tb-ai:hover {
  border-color: #9e7bd5;
}

/* --- Bottom status bar --- */

.status-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 12px;
  background: #1f1f1f;
  border-top: 1px solid #0f0f0f;
  color: #cccccc;
  font-size: 11.5px;
  min-height: 22px;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0; /* allow .status-path to ellipsis inside flex */
}

.status-path {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #cccccc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60vw;
}

.status-copy {
  background: transparent;
  border: none;
  color: #aaaaaa;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  box-shadow: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.status-copy:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.status-label {
  color: #888;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.status-lang {
  background: transparent;
  color: #cccccc;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  /* native arrow on macOS makes the select compact and readable */
}

.status-lang:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: #3a3a3a;
}

.status-lang:focus {
  border-color: #4287d6;
}

.status-kind {
  color: #888;
  font-size: 11.5px;
  text-transform: capitalize;
}

/* --- Modals (AI Assist + AI Settings) --- */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: #252526;
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  width: 560px;
  max-width: 92vw;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 18px;
  border-bottom: 1px solid #1a1a1a;
}

.modal-header h3 {
  margin: 0;
  font-size: 14px;
  color: #fff;
  font-weight: 600;
}

.modal-close {
  background: transparent;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  box-shadow: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.modal-close:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.modal-close:disabled {
  opacity: 0.4;
  cursor: default;
}

.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  flex: 1;
}

.modal-body label {
  display: block;
  margin: 12px 0 4px;
  font-size: 12px;
  color: #aaa;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.modal-body label:first-child {
  margin-top: 0;
}

.modal-body input,
.modal-body select,
.modal-body textarea {
  width: 100%;
  background: #1e1e1e;
  color: #d4d4d4;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.modal-body input:focus,
.modal-body select:focus,
.modal-body textarea:focus {
  border-color: #4287d6;
  background: #1a1a1a;
}

.modal-body textarea {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
  resize: vertical;
  line-height: 1.5;
}

.modal-body .hint {
  font-size: 11px;
  color: #777;
  margin-top: 4px;
}

.modal-footer {
  padding: 12px 18px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid #1a1a1a;
}

.modal-footer button {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
  box-shadow: none;
}

.modal-footer button:hover:not(:disabled) {
  border-color: #444;
}

.modal-footer button.primary {
  background: #094771;
  color: #fff;
  border-color: #0e6ab8;
}

.modal-footer button.primary:hover:not(:disabled) {
  background: #0c5891;
}

.modal-footer button.danger {
  background: #5a2424;
  color: #f4d0d0;
  border-color: #8a3838;
}

.modal-footer button.danger:hover:not(:disabled) {
  background: #6e2c2c;
}

.modal-footer button:disabled {
  opacity: 0.4;
  cursor: default;
}

/* AI dialog — selected-text preview block */
.selected-preview {
  margin-bottom: 14px;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #1a1a1a;
  padding: 8px 10px;
}

.preview-label {
  font-size: 11px;
  color: #888;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.selected-preview pre {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 140px;
  overflow-y: auto;
}

.ai-error {
  margin-top: 10px;
  padding: 8px 10px;
  background: #3a1f1f;
  border-left: 3px solid #d04040;
  color: #f4a8a8;
  font-size: 12px;
  border-radius: 4px;
  word-break: break-word;
}

/* --- Close-confirmation modal --- */

.close-warn-icon {
  color: #e8b765;
  margin-right: 6px;
  vertical-align: -2px;
}

.modal-header h3 {
  display: inline-flex;
  align-items: center;
  gap: 0;
}

.close-summary {
  margin: 0 0 12px 0;
  color: #d4d4d4;
  font-size: 13px;
  line-height: 1.5;
}

.close-dirty-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #1a1a1a;
  max-height: 240px;
  overflow-y: auto;
}

.close-dirty-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  border-bottom: 1px solid #232323;
}

.close-dirty-list li:last-child {
  border-bottom: none;
}

.close-dirty-list li.close-unsavable {
  background: #2a2018;
}

.close-dirty-icon {
  color: #9aa1ad;
  flex-shrink: 0;
}

.close-dirty-name {
  color: #ffffff;
  font-weight: 500;
  flex-shrink: 0;
}

.close-dirty-warn {
  color: #e8b765;
  font-size: 11px;
  margin-left: auto;
}

.close-dirty-path {
  color: #888;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* --- Draft recovery modal --- */

.recovery-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #1a1a1a;
  max-height: 320px;
  overflow-y: auto;
}

.recovery-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  font-size: 12.5px;
  border-bottom: 1px solid #232323;
}

.recovery-item:last-child {
  border-bottom: none;
}

.recovery-item-icon {
  color: #9aa1ad;
  flex-shrink: 0;
}

.recovery-info {
  flex: 1;
  min-width: 0;
}

.recovery-row-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.recovery-name {
  color: #ffffff;
  font-weight: 500;
  flex-shrink: 0;
}

.recovery-time {
  color: #888;
  font-size: 11px;
}

.recovery-path {
  color: #888;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

.recovery-untitled {
  color: #e8b765;
  font-size: 11px;
  margin-top: 2px;
}

.recovery-action {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  box-shadow: none;
}

.recovery-action:hover {
  border-color: #4287d6;
}

.recovery-action.recovery-danger {
  padding: 4px 7px;
  line-height: 0;
}

.recovery-action.recovery-danger:hover {
  background: rgba(255, 80, 80, 0.15);
  border-color: #8a3838;
  color: #f08a8a;
}

/* --- Auto-update modal --- */

.update-notes {
  margin: 10px 0;
  padding: 10px 12px;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
  color: #cccccc;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.update-progress-wrap {
  margin-top: 16px;
}

.update-progress-bar {
  width: 100%;
  height: 6px;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  overflow: hidden;
}

.update-progress-fill {
  height: 100%;
  background: #4287d6;
  transition: width 120ms linear;
}

.update-progress-label {
  margin-top: 6px;
  font-size: 11.5px;
  color: #aaa;
  font-variant-numeric: tabular-nums;
}

/* --- Snippets --- */

.tb-snippet {
  background: #2a3f2a;
  color: #c0e0c0;
}

.tb-snippet:hover {
  border-color: #6ca06c;
}

.modal-snippets {
  width: 620px;
}

.snippet-preview {
  margin: 0;
  padding: 8px 10px;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}

.snippet-search {
  margin-bottom: 10px;
}

.snippet-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 50vh;
  overflow-y: auto;
}

.snippet-empty {
  text-align: center;
  padding: 24px 16px;
  color: #888;
  font-size: 12px;
  line-height: 1.5;
}

.snippet-item {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #1c1c1c;
  transition: border-color 0.1s;
}

.snippet-item:hover {
  border-color: #4287d6;
}

.snippet-body {
  flex: 1;
  cursor: pointer;
  min-width: 0;
}

.snippet-row-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.snippet-name {
  font-weight: 600;
  color: #fff;
  font-size: 13px;
}

.snippet-lang {
  color: #888;
  font-size: 10.5px;
  background: #2a2a2a;
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: lowercase;
}

.snippet-desc {
  color: #aaa;
  font-size: 11.5px;
  margin-top: 3px;
}

.snippet-content {
  margin: 6px 0 0 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 90px;
  overflow: hidden;
  background: #141414;
  padding: 6px 8px;
  border-radius: 3px;
}

.snippet-delete {
  background: transparent;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  height: fit-content;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  box-shadow: none;
}

.snippet-delete:hover {
  background: rgba(255, 80, 80, 0.15);
  color: #f08a8a;
}

/* --- Quick Actions --- */

.tb-action {
  background: #3d3320;
  color: #f0d8a0;
}

.tb-action:hover {
  border-color: #d3a655;
}

.action-toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.action-search {
  margin-bottom: 0;
  flex: 1;
}

.action-new-btn {
  background: #3d3320;
  color: #f0d8a0;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  box-shadow: none;
}

.action-new-btn:hover {
  border-color: #d3a655;
  background: #4a3f29;
}

.action-vars-hint {
  font-size: 11px;
  color: #888;
  margin-bottom: 10px;
  line-height: 1.5;
}

.action-vars-hint code {
  background: #2a2a2a;
  color: #d3a655;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10.5px;
}

.action-run-hint {
  color: #888;
  font-size: 10.5px;
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  background: #161616;
}

.snippet-item:hover .action-run-hint {
  color: #d3a655;
  border-color: #d3a655;
}

.action-type-toggle {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}

.action-type-option {
  display: flex !important;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  margin: 0 !important;
  padding: 6px 10px;
  border-radius: 4px;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  font-size: 12px !important;
  color: #cccccc !important;
  text-transform: none !important;
  letter-spacing: normal !important;
  font-weight: normal !important;
}

.action-type-option input[type="radio"] {
  width: auto !important;
  margin: 0;
  accent-color: #4287d6;
}

.action-type-option:hover {
  border-color: #444;
}

.path-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.path-row input {
  flex: 1;
  min-width: 0;
}

.path-pick-btn {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 0 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
  box-shadow: none;
  flex-shrink: 0;
}

.path-pick-btn:hover {
  border-color: #4287d6;
}

.action-type-pill {
  background: #2a2a2a;
  color: #aaa;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 10px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  text-transform: lowercase;
  letter-spacing: 0.4px;
}

.action-type-pill.action-type-python {
  background: #1f3a3a;
  color: #76d2c8;
}

.action-type-pill.action-type-shell {
  background: #3a2f1f;
  color: #f0d8a0;
}

.action-type-pill.action-type-text {
  background: #2a2a2a;
  color: #aaaaaa;
}

.action-type-pill.action-type-prompt {
  background: #3a2a4d;
  color: #e0cdf5;
}

/* Make sure the editable snippet content textarea reads as code. */
.snippet-content-input {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
  font-size: 14px;
}
</style>
