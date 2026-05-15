<script setup>
// Code search tab — ripgrep-flavored content search over a folder.
//
// Calls the `code_search` Rust command (which links the same grep crates
// ripgrep is built from). Returns:
//
//   {
//     files: [
//       {
//         relative_path: "src/foo.rs",
//         absolute_path: "/home/.../src/foo.rs",
//         matches: [{ line_number, column, match_len, text }],
//         total_matches: 7
//       }
//     ],
//     truncated: bool,
//     files_scanned: u64
//   }
//
// UI:
//   - Top toolbar: folder selector, search input, toggles (Aa, .*, \\b),
//     and an optional include-glob input.
//   - Results: each file is a row of <header> + child <match-line> rows.
//     Clicking a match emits `open-file` with `{path, line, column}` so
//     the host can open the file at the right spot.

import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Search,
  FolderOpen,
  CaseSensitive,
  Regex,
  WholeWord,
  ChevronDown,
  ChevronRight,
} from "lucide-vue-next";

const props = defineProps({
  initialRoot: { type: String, default: "" },
  initialQuery: { type: String, default: "" },
  active: { type: Boolean, default: false },
});
const emit = defineEmits(["open-file", "title-change"]);

const root = ref(props.initialRoot || "");
const query = ref(props.initialQuery || "");
const useRegex = ref(false);
const caseSensitive = ref(false);
const wholeWord = ref(false);
const includeGlob = ref("");
const includeHidden = ref(false);

const results = ref([]);
const truncated = ref(false);
const filesScanned = ref(0);
const errorMsg = ref("");
const loading = ref(false);
const elapsedMs = ref(0);

// Per-file collapse state, keyed by absolute_path. Defaults to expanded;
// the user can toggle to hide a file's match list.
const collapsed = ref(new Set());
function toggleCollapsed(path) {
  if (collapsed.value.has(path)) collapsed.value.delete(path);
  else collapsed.value.add(path);
  // Set is reactive only when reassigned; clone-and-replace to trigger.
  collapsed.value = new Set(collapsed.value);
}

const queryInput = ref(null);

const totalMatches = computed(() =>
  results.value.reduce((sum, f) => sum + f.total_matches, 0)
);

// Auto-search after a short debounce so the user can keep typing without
// firing a request per keystroke. 250 ms feels live without thrashing.
let debounceTimer = null;
function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSearch();
  }, 250);
}

watch([query, useRegex, caseSensitive, wholeWord, includeGlob, includeHidden], () => {
  scheduleSearch();
});

async function pickRoot() {
  try {
    const chosen = await openDialog({
      title: "Search in folder",
      directory: true,
      multiple: false,
    });
    if (!chosen) return;
    root.value = Array.isArray(chosen) ? chosen[0] : chosen;
    scheduleSearch();
  } catch (err) {
    errorMsg.value = String(err);
  }
}

async function runSearch() {
  if (!root.value.trim()) {
    results.value = [];
    errorMsg.value = "Pick a folder to search in.";
    return;
  }
  if (!query.value.trim()) {
    results.value = [];
    errorMsg.value = "";
    truncated.value = false;
    filesScanned.value = 0;
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  const start = performance.now();
  try {
    const resp = await invoke("code_search", {
      input: {
        root: root.value,
        query: query.value,
        regex: useRegex.value,
        case_sensitive: caseSensitive.value,
        whole_word: wholeWord.value,
        include_glob: includeGlob.value,
        include_hidden: includeHidden.value,
      },
    });
    results.value = resp.files || [];
    truncated.value = !!resp.truncated;
    filesScanned.value = resp.files_scanned || 0;
  } catch (err) {
    results.value = [];
    errorMsg.value = String(err);
  } finally {
    elapsedMs.value = Math.round(performance.now() - start);
    loading.value = false;
  }
}

function clickMatch(file, m) {
  emit("open-file", {
    path: file.absolute_path,
    line: m.line_number,
    column: m.column,
  });
}

// Compose a title so the host's tab strip reflects the current query.
// We emit on changes (debounced via watcher) so the tab dropdown stays
// in sync even when this tab is in the background.
watch(query, (q) => {
  emit("title-change", `Search: ${q || "…"}`);
});

// Split a result line into [before, hit, after] so we can highlight
// the matched range inline. `column` is 1-based from the Rust side.
// If column/match_len are zero (no match info), we fall back to a
// simple includes()-style highlight via lower-cased indexOf.
function lineParts(text, column, matchLen) {
  if (!text) return ["", "", ""];
  if (matchLen > 0 && column >= 1) {
    const start = column - 1;
    const end = start + matchLen;
    return [text.slice(0, start), text.slice(start, end), text.slice(end)];
  }
  // Fallback: indexOf with current query (case-insensitive smart).
  const q = query.value || "";
  if (!q) return [text, "", ""];
  const hay = caseSensitive.value ? text : text.toLowerCase();
  const needle = caseSensitive.value ? q : q.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return [text, "", ""];
  return [
    text.slice(0, idx),
    text.slice(idx, idx + needle.length),
    text.slice(idx + needle.length),
  ];
}

onMounted(async () => {
  await nextTick();
  if (queryInput.value) queryInput.value.focus();
  if (props.initialQuery) scheduleSearch();
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="search-tab">
    <div class="search-toolbar">
      <button
        class="ex-btn"
        @click="pickRoot"
        :title="root || 'Pick a folder to search in'"
      >
        <FolderOpen :size="13" />
        <span class="root-label">{{ root || "Pick folder" }}</span>
      </button>

      <div class="query-row">
        <Search :size="14" class="query-icon" />
        <input
          ref="queryInput"
          v-model="query"
          class="query-input"
          placeholder="Search for text…  (regex / case / whole-word toggles on the right)"
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
          @keydown.enter.prevent="runSearch"
        />
        <button
          class="opt-btn"
          :class="{ on: caseSensitive }"
          @click="caseSensitive = !caseSensitive"
          title="Case sensitive (Aa)"
        ><CaseSensitive :size="13" /></button>
        <button
          class="opt-btn"
          :class="{ on: wholeWord }"
          @click="wholeWord = !wholeWord"
          title="Match whole word"
        ><WholeWord :size="13" /></button>
        <button
          class="opt-btn"
          :class="{ on: useRegex }"
          @click="useRegex = !useRegex"
          title="Use regular expression"
        ><Regex :size="13" /></button>
      </div>

      <div class="include-row">
        <input
          v-model="includeGlob"
          class="include-input"
          placeholder='Include files (glob, e.g. "*.rs" or "src/**/*.ts")'
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
        />
        <label class="hidden-toggle" title="Search hidden files / dirs">
          <input type="checkbox" v-model="includeHidden" />
          .hidden
        </label>
      </div>
    </div>

    <div class="search-status">
      <span v-if="loading">Searching…</span>
      <span v-else-if="errorMsg" class="error">{{ errorMsg }}</span>
      <span v-else-if="results.length === 0 && query">
        No matches in {{ filesScanned }} file{{ filesScanned === 1 ? "" : "s" }}.
      </span>
      <span v-else-if="results.length > 0">
        {{ totalMatches }} match{{ totalMatches === 1 ? "" : "es" }}
        in {{ results.length }} file{{ results.length === 1 ? "" : "s" }}
        <span class="muted">— scanned {{ filesScanned }} in {{ elapsedMs }} ms</span>
        <span v-if="truncated" class="warn">
          · truncated, narrow your query
        </span>
      </span>
    </div>

    <div class="search-results">
      <div
        v-for="file in results"
        :key="file.absolute_path"
        class="result-file"
      >
        <div class="file-header" @click="toggleCollapsed(file.absolute_path)">
          <component
            :is="collapsed.has(file.absolute_path) ? ChevronRight : ChevronDown"
            :size="12"
            class="file-chevron"
          />
          <span class="file-path" :title="file.absolute_path">
            {{ file.relative_path }}
          </span>
          <span class="file-count">{{ file.total_matches }}</span>
        </div>
        <div v-show="!collapsed.has(file.absolute_path)" class="file-matches">
          <div
            v-for="m in file.matches"
            :key="m.line_number + ':' + m.column"
            class="match-row"
            @click="clickMatch(file, m)"
          >
            <span class="match-lineno">{{ m.line_number }}</span>
            <span class="match-text">
              <template v-for="(part, idx) in lineParts(m.text, m.column, m.match_len)" :key="idx">
                <span v-if="idx === 1" class="match-hit">{{ part }}</span>
                <span v-else>{{ part }}</span>
              </template>
            </span>
          </div>
          <div
            v-if="file.total_matches > file.matches.length"
            class="match-more"
          >
            … {{ file.total_matches - file.matches.length }} more (capped)
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-tab {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  color: #d4d4d4;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
    sans-serif;
  overflow: hidden;
  box-sizing: border-box;
}

.search-toolbar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: #252526;
  border-bottom: 1px solid #1a1a1a;
}

.ex-btn {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  max-width: 100%;
}
.ex-btn:hover {
  border-color: #396cd8;
  background: #333;
}
.root-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.query-row {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #2d2d2d;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  padding: 4px 6px;
}
.query-row:focus-within {
  border-color: #396cd8;
}

.query-icon {
  color: #888;
  flex-shrink: 0;
}

.query-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: 0;
  color: #d4d4d4;
  font-size: 13px;
  font-family: inherit;
}
.query-input::placeholder {
  color: #777;
}

.opt-btn {
  background: transparent;
  border: 1px solid transparent;
  color: #888;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  line-height: 0;
}
.opt-btn:hover {
  color: #ccc;
  background: rgba(255, 255, 255, 0.04);
}
.opt-btn.on {
  color: #6fa8dc;
  background: rgba(111, 168, 220, 0.14);
  border-color: rgba(111, 168, 220, 0.35);
}

.include-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.include-input {
  flex: 1;
  background: #2d2d2d;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  color: #d4d4d4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.include-input:focus {
  outline: none;
  border-color: #396cd8;
}

.hidden-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #aaa;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.search-status {
  flex: 0 0 auto;
  padding: 4px 12px;
  font-size: 11px;
  color: #aaa;
  border-bottom: 1px solid #1a1a1a;
}
.search-status .muted {
  color: #777;
}
.search-status .warn {
  color: #d8a05a;
}
.search-status .error {
  color: #f08a8a;
}

.search-results {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.result-file {
  border-bottom: 1px solid #232323;
}

.file-header {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  background: #252526;
  position: sticky;
  top: 0;
  z-index: 1;
}
.file-header:hover {
  background: #2c2c2d;
}

.file-chevron {
  color: #888;
}
.file-path {
  color: #d4d4d4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.file-count {
  background: #3a3a3a;
  color: #d4d4d4;
  border-radius: 8px;
  padding: 1px 8px;
  font-size: 11px;
  font-family: inherit;
}

.file-matches {
  background: #1e1e1e;
}

.match-row {
  display: grid;
  grid-template-columns: 50px 1fr;
  gap: 6px;
  padding: 1px 12px;
  cursor: pointer;
  font-size: 12px;
  align-items: baseline;
}
.match-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.match-lineno {
  color: #777;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.match-text {
  color: #d4d4d4;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.match-hit {
  background: rgba(255, 215, 0, 0.22);
  color: #ffeaa8;
  border-radius: 2px;
}

.match-more {
  padding: 2px 12px 4px 68px;
  color: #777;
  font-size: 11px;
  font-style: italic;
}
</style>
