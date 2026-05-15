<script setup>
// In-app file explorer. Backed by two Rust commands:
//   list_directory(path) -> [{name, path, is_dir, size}]
//   path_parent(path)    -> string | null
//
// The component owns its current path. Clicking a directory navigates into
// it; clicking a file emits `open-file` so the parent (TabbedMonacoEditor)
// can open it as an editor tab.

import { ref, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  // Folders
  Folder,
  // File flavors
  File,
  FileText,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileImage,
  FileArchive,
  // Toolbar glyphs
  ArrowUp,
  RefreshCw,
} from "lucide-vue-next";

const props = defineProps({
  initialPath: { type: String, required: true },
  active: { type: Boolean, default: false },
});
const emit = defineEmits(["open-file", "path-change"]);

const currentPath = ref(props.initialPath);
const entries = ref([]);
const loading = ref(false);
const errorMsg = ref("");
// Persisted preference. Default is "show" because the previous default
// (hide) made dotfiles like `.env`, `.gitignore`, and `.github/` invisible
// — and those are exactly the files developers usually want to find.
const showHidden = ref(
  typeof localStorage !== "undefined"
    ? localStorage.getItem("sparrow.explorerShowHidden") !== "0"
    : true
);
watch(showHidden, (v) => {
  try {
    localStorage.setItem("sparrow.explorerShowHidden", v ? "1" : "0");
  } catch (_) {
    /* ignore quota / private mode */
  }
});

async function loadDir(path) {
  loading.value = true;
  errorMsg.value = "";
  try {
    const result = await invoke("list_directory", { path });
    entries.value = result || [];
    currentPath.value = path;
    emit("path-change", path);
  } catch (err) {
    errorMsg.value = String(err);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

async function goUp() {
  try {
    const parent = await invoke("path_parent", { path: currentPath.value });
    if (parent) await loadDir(parent);
  } catch (err) {
    errorMsg.value = String(err);
  }
}

function refresh() {
  loadDir(currentPath.value);
}

function onEntryClick(entry) {
  if (entry.is_dir) {
    loadDir(entry.path);
  } else {
    emit("open-file", entry.path);
  }
}

// Visible list — applies the "hide dotfiles" filter.
function visibleEntries() {
  if (showHidden.value) return entries.value;
  return entries.value.filter((e) => !e.name.startsWith("."));
}

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Buckets we colorize independently. Returned as a kebab-friendly string so
// the template can compose `entry-icon-${kind}` straight onto the SVG.
function iconKindForEntry(entry) {
  if (entry.is_dir) return "folder";
  const ext = (entry.name.split(".").pop() || "").toLowerCase();
  if (
    ext === "json" ||
    ext === "jsonc" ||
    ext === "ndjson" ||
    ext === "geojson"
  )
    return "json";
  if (
    ext === "csv" ||
    ext === "tsv" ||
    ext === "xlsx" ||
    ext === "xls" ||
    ext === "ods"
  )
    return "spreadsheet";
  if (
    [
      "js", "mjs", "cjs", "jsx",
      "ts", "tsx",
      "py", "rb", "php", "pl",
      "rs", "go", "java", "kt", "swift",
      "c", "h", "cpp", "hpp", "cc", "cs",
      "sh", "bash", "zsh", "fish",
      "html", "htm", "css", "scss", "less",
      "vue", "svelte",
      "sql", "yaml", "yml", "toml", "ini", "xml",
      "http", "rest",
      "lua", "r", "dart", "scala",
    ].includes(ext)
  )
    return "code";
  if (
    [
      "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff",
    ].includes(ext)
  )
    return "image";
  if (
    [
      "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z",
    ].includes(ext)
  )
    return "archive";
  if (["md", "markdown", "txt", "rst", "log", "pdf"].includes(ext))
    return "text";
  return "file";
}

function iconForEntry(entry) {
  switch (iconKindForEntry(entry)) {
    case "folder":
      return Folder;
    case "json":
      return FileJson;
    case "spreadsheet":
      return FileSpreadsheet;
    case "code":
      return FileCode2;
    case "image":
      return FileImage;
    case "archive":
      return FileArchive;
    case "text":
      return FileText;
    default:
      return File;
  }
}

onMounted(() => {
  loadDir(currentPath.value);
});

// If the parent ever swaps initialPath (e.g. user opened the explorer from a
// different root), navigate there.
watch(
  () => props.initialPath,
  (newPath) => {
    if (newPath && newPath !== currentPath.value) loadDir(newPath);
  }
);
</script>

<template>
  <div class="explorer">
    <div class="explorer-toolbar">
      <button
        class="ex-btn"
        @click="goUp"
        :disabled="loading"
        title="Up one level"
      ><ArrowUp :size="14" /></button>
      <button
        class="ex-btn"
        @click="refresh"
        :disabled="loading"
        title="Refresh"
      ><RefreshCw :size="13" /></button>
      <span class="path-display" :title="currentPath">{{ currentPath }}</span>
      <label class="hidden-toggle">
        <input type="checkbox" v-model="showHidden" />
        Show hidden
      </label>
    </div>

    <div class="entry-list">
      <div v-if="loading" class="status">Loading…</div>
      <div v-else-if="errorMsg" class="status error">{{ errorMsg }}</div>
      <div v-else-if="visibleEntries().length === 0" class="status">
        Empty folder
      </div>
      <template v-else>
        <div
          v-for="entry in visibleEntries()"
          :key="entry.path"
          class="entry"
          :class="[entry.is_dir ? 'dir' : 'file', `entry-kind-${iconKindForEntry(entry)}`]"
          @click="onEntryClick(entry)"
          :title="entry.path"
        >
          <component
            :is="iconForEntry(entry)"
            :size="14"
            class="entry-icon"
          />
          <span class="entry-name">{{ entry.name }}</span>
          <span class="entry-meta">{{ entry.is_dir ? "" : formatSize(entry.size) }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.explorer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  color: #d4d4d4;
  font-size: 13px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  box-sizing: border-box;
}

.explorer-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #252526;
  border-bottom: 1px solid #1e1e1e;
  flex: 0 0 auto;
}

.ex-btn {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.ex-btn:hover:not(:disabled) {
  border-color: #396cd8;
  background: #333;
}

.ex-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.path-display {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #cccccc;
  font-size: 12px;
  padding: 0 6px;
}

.hidden-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #aaa;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  cursor: pointer;
  user-select: none;
}

.entry-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
}

.status {
  padding: 14px 16px;
  color: #888;
  font-size: 12px;
}

.status.error {
  color: #f08a8a;
}

.entry {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  cursor: pointer;
  user-select: none;
}

.entry:hover {
  background: #2a2d2e;
}

.entry-icon {
  color: #888;
  flex-shrink: 0;
}

.entry.dir .entry-name {
  color: #f5e7b8;
}

.entry.file .entry-name {
  color: #d4d4d4;
}

/* Per-kind icon colors. SVGs use stroke=currentColor so this just works. */
.entry-kind-folder .entry-icon {
  color: #d7ba7d;
}

.entry-kind-code .entry-icon {
  color: #6fa8dc;
}

.entry-kind-json .entry-icon {
  color: #d3a655;
}

.entry-kind-spreadsheet .entry-icon {
  color: #7bc97b;
}

.entry-kind-image .entry-icon {
  color: #d36cc4;
}

.entry-kind-archive .entry-icon {
  color: #c97b4a;
}

.entry-kind-text .entry-icon {
  color: #cccccc;
}

.entry-kind-file .entry-icon {
  color: #888888;
}

.entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-meta {
  color: #777;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
