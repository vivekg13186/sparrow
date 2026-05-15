<script setup>
// Git browser tab.
//
// Wraps the system `git` binary through six Rust commands:
//   git_status(path)            -> { branch, ahead, behind, has_commits, files: [{status, staged, path, old_path}] }
//   git_add(path, files)        -> ()         (empty files = stage all)
//   git_reset(path, files)      -> ()         (empty files = unstage all)
//   git_commit(path, message)   -> ()
//   git_pull(path)              -> stdout
//   git_push(path)              -> stdout
//   git_diff(path, file, staged) -> unified diff text
//
// The view mirrors VS Code's Source Control sidebar at a high level:
//   - Header with the branch label, ahead/behind chips, and pull/push.
//   - Commit message textarea + Commit button.
//   - Two collapsible lists: Staged Changes and Changes.
//   - Each row has a status badge, the path, and stage/unstage buttons.
//   - Clicking a row opens a unified-diff modal for that file.
//
// We deliberately don't try to be a full git client (branches, log
// browser, conflict resolver, …). The goal is to cover what people do
// 90% of the time without leaving the editor: see what's changed, stage,
// commit, sync.

import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpToLine,
  ArrowDownToLine,
  RefreshCw,
  Plus,
  Minus,
  GitBranch,
  GitCommitHorizontal,
  X,
} from "lucide-vue-next";

const props = defineProps({
  repoPath: { type: String, required: true },
  active: { type: Boolean, default: false },
});
const emit = defineEmits(["open-file", "title-change"]);

const branch = ref(null);
const ahead = ref(null);
const behind = ref(null);
const hasCommits = ref(true);
const stagedFiles = ref([]);
const unstagedFiles = ref([]);
const commitMessage = ref("");
const loading = ref(false);
const busy = ref(false);
const errorMsg = ref("");
const statusFlash = ref("");

// Diff modal state. We keep the body as a string and let CSS handle the
// monospace + scroll. Coloring per-line happens client-side via a small
// classifier.
const diffOpen = ref(false);
const diffFile = ref("");
const diffStaged = ref(false);
const diffBody = ref("");
const diffLoading = ref(false);

let flashTimer = null;
function flash(msg) {
  statusFlash.value = msg;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    statusFlash.value = "";
  }, 3500);
}

async function refresh() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const s = await invoke("git_status", { path: props.repoPath });
    branch.value = s.branch || null;
    ahead.value = s.ahead;
    behind.value = s.behind;
    hasCommits.value = s.has_commits;
    stagedFiles.value = s.files.filter((f) => f.staged);
    unstagedFiles.value = s.files.filter((f) => !f.staged);
    emit("title-change", `Git: ${shortRepoName.value}`);
  } catch (err) {
    errorMsg.value = String(err);
  } finally {
    loading.value = false;
  }
}

const shortRepoName = computed(() => {
  const p = props.repoPath || "";
  const seg = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return seg >= 0 ? p.slice(seg + 1) : p;
});

const canCommit = computed(
  () => stagedFiles.value.length > 0 && commitMessage.value.trim().length > 0
);

// Single source of truth for "what should the X/Y porcelain code look
// like as a tinted badge?" — keeps the staged and unstaged lists visually
// consistent.
function badgeFor(file) {
  const map = {
    M: { label: "M", title: "Modified", color: "#d8a05a" },
    A: { label: "A", title: "Added", color: "#7bc97b" },
    D: { label: "D", title: "Deleted", color: "#e57373" },
    R: { label: "R", title: "Renamed", color: "#9c7bd6" },
    C: { label: "C", title: "Copied", color: "#9c7bd6" },
    U: { label: "U", title: "Conflicted", color: "#e57373" },
    "?": { label: "U", title: "Untracked", color: "#6fa8dc" },
  };
  return map[file.status] || { label: file.status, title: file.status, color: "#aaaaaa" };
}

async function runWithBusy(label, fn) {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await fn();
    flash(label);
    await refresh();
    return result;
  } catch (err) {
    flash(`Error: ${err}`);
    console.warn("[git]", label, err);
  } finally {
    busy.value = false;
  }
}

function stageFile(file) {
  // Renames use the new path on the index side. Untracked stages the
  // file as-is. Either way `git add <path>` is the right operation.
  return runWithBusy(`Staged ${file.path}`, () =>
    invoke("git_add", { path: props.repoPath, files: [file.path] })
  );
}

function unstageFile(file) {
  return runWithBusy(`Unstaged ${file.path}`, () =>
    invoke("git_reset", { path: props.repoPath, files: [file.path] })
  );
}

function stageAll() {
  return runWithBusy("Staged all changes", () =>
    invoke("git_add", { path: props.repoPath, files: [] })
  );
}

function unstageAll() {
  return runWithBusy("Unstaged all", () =>
    invoke("git_reset", { path: props.repoPath, files: [] })
  );
}

function commit() {
  if (!canCommit.value) return;
  const msg = commitMessage.value;
  return runWithBusy("Commit created", async () => {
    await invoke("git_commit", { path: props.repoPath, message: msg });
    commitMessage.value = "";
  });
}

function pull() {
  return runWithBusy("Pulled", async () => {
    const out = await invoke("git_pull", { path: props.repoPath });
    // git's "Already up to date." or fast-forward summary — log to console
    // so curious users can see it, while the flash stays terse.
    if (out) console.info("[git pull]", out);
  });
}

function push() {
  return runWithBusy("Pushed", async () => {
    const out = await invoke("git_push", { path: props.repoPath });
    if (out) console.info("[git push]", out);
  });
}

async function openDiff(file) {
  diffOpen.value = true;
  diffFile.value = file.path;
  diffStaged.value = !!file.staged;
  diffLoading.value = true;
  diffBody.value = "";
  try {
    diffBody.value = await invoke("git_diff", {
      path: props.repoPath,
      file: file.path,
      staged: !!file.staged,
    });
    if (!diffBody.value || !diffBody.value.trim()) {
      diffBody.value = file.status === "?"
        ? "(untracked — `git diff` shows nothing until you stage it)"
        : "(no textual diff — binary file or no changes)";
    }
  } catch (err) {
    diffBody.value = String(err);
  } finally {
    diffLoading.value = false;
  }
}

function closeDiff() {
  diffOpen.value = false;
  diffBody.value = "";
}

// Classify a diff line so the template can tint it. We don't write
// styled <span>s per line — keeping diff text as raw `<pre>` content
// is faster and gives users the option to copy a clean patch.
function diffLineClass(line) {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

// Split the diff into lines once so the template doesn't redo the work
// every render. Computed off the body string.
const diffLines = computed(() => (diffBody.value || "").split("\n"));

// Open a file in a real editor tab. The tab host listens for this and
// pipes the path through openPathSmart (the same path File → Open uses).
function openInEditor(file) {
  // Renamed files use the new path.
  const sep = props.repoPath.includes("\\") ? "\\" : "/";
  const full = props.repoPath + sep + file.path;
  emit("open-file", full);
}

// When this tab becomes the active one again, refresh — the user may
// have changed files in other tabs and we want the list current.
watch(
  () => props.active,
  (now) => {
    if (now) refresh();
  }
);

onMounted(() => {
  refresh();
});
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
});
</script>

<template>
  <div class="git-tab">
    <!-- Header: branch + sync buttons + manual refresh -->
    <div class="git-header">
      <div class="branch-info">
        <GitBranch :size="14" class="branch-icon" />
        <span class="branch-name">
          {{ branch || (hasCommits ? "no branch" : "fresh repo — no commits yet") }}
        </span>
        <span
          v-if="ahead != null && ahead > 0"
          class="ab-chip ab-ahead"
          :title="`${ahead} local commit${ahead === 1 ? '' : 's'} ahead of upstream`"
        >
          <ArrowUpToLine :size="11" /> {{ ahead }}
        </span>
        <span
          v-if="behind != null && behind > 0"
          class="ab-chip ab-behind"
          :title="`${behind} upstream commit${behind === 1 ? '' : 's'} not yet pulled`"
        >
          <ArrowDownToLine :size="11" /> {{ behind }}
        </span>
      </div>
      <div class="header-actions">
        <button
          class="git-btn"
          @click="pull"
          :disabled="busy"
          title="git pull"
        ><ArrowDownToLine :size="13" /> Pull</button>
        <button
          class="git-btn"
          @click="push"
          :disabled="busy"
          title="git push"
        ><ArrowUpToLine :size="13" /> Push</button>
        <button
          class="git-btn ghost"
          @click="refresh"
          :disabled="busy"
          title="Refresh status"
        ><RefreshCw :size="13" /></button>
      </div>
    </div>

    <div class="repo-path" :title="repoPath">{{ repoPath }}</div>
    <div v-if="statusFlash" class="git-flash">{{ statusFlash }}</div>
    <div v-if="errorMsg" class="git-error">{{ errorMsg }}</div>

    <!-- Commit area -->
    <div class="commit-box">
      <textarea
        v-model="commitMessage"
        class="commit-msg"
        rows="3"
        placeholder="Commit message (Cmd/Ctrl+Enter to commit)"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        @keydown.meta.enter.prevent="commit"
        @keydown.ctrl.enter.prevent="commit"
      ></textarea>
      <button
        class="git-btn primary"
        :disabled="!canCommit || busy"
        @click="commit"
      ><GitCommitHorizontal :size="13" /> Commit ({{ stagedFiles.length }})</button>
    </div>

    <!-- Staged section -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Staged Changes ({{ stagedFiles.length }})</span>
        <button
          v-if="stagedFiles.length > 0"
          class="link-btn"
          :disabled="busy"
          @click="unstageAll"
          title="Move all staged files back to unstaged"
        >Unstage all</button>
      </div>
      <div v-if="stagedFiles.length === 0" class="section-empty">
        Nothing staged.
      </div>
      <div v-else class="file-list">
        <div
          v-for="file in stagedFiles"
          :key="'s:' + file.path"
          class="file-row"
        >
          <span
            class="file-badge"
            :style="{ color: badgeFor(file).color, borderColor: badgeFor(file).color }"
            :title="badgeFor(file).title"
          >{{ badgeFor(file).label }}</span>
          <span class="file-path" @click="openDiff(file)" :title="file.path">
            {{ file.path }}
            <span v-if="file.old_path" class="file-old">
              ← {{ file.old_path }}
            </span>
          </span>
          <span class="file-actions">
            <button
              class="row-btn"
              @click="openInEditor(file)"
              :disabled="busy"
              title="Open file in editor"
            >Open</button>
            <button
              class="row-btn"
              @click="unstageFile(file)"
              :disabled="busy"
              title="Unstage this file"
            ><Minus :size="11" /></button>
          </span>
        </div>
      </div>
    </div>

    <!-- Unstaged section -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Changes ({{ unstagedFiles.length }})</span>
        <button
          v-if="unstagedFiles.length > 0"
          class="link-btn"
          :disabled="busy"
          @click="stageAll"
          title="Stage every unstaged change at once"
        >Stage all</button>
      </div>
      <div v-if="unstagedFiles.length === 0" class="section-empty">
        Working tree is clean.
      </div>
      <div v-else class="file-list">
        <div
          v-for="file in unstagedFiles"
          :key="'u:' + file.path"
          class="file-row"
        >
          <span
            class="file-badge"
            :style="{ color: badgeFor(file).color, borderColor: badgeFor(file).color }"
            :title="badgeFor(file).title"
          >{{ badgeFor(file).label }}</span>
          <span class="file-path" @click="openDiff(file)" :title="file.path">
            {{ file.path }}
            <span v-if="file.old_path" class="file-old">
              ← {{ file.old_path }}
            </span>
          </span>
          <span class="file-actions">
            <button
              class="row-btn"
              @click="openInEditor(file)"
              :disabled="busy"
              title="Open file in editor"
            >Open</button>
            <button
              class="row-btn"
              @click="stageFile(file)"
              :disabled="busy"
              title="Stage this file"
            ><Plus :size="11" /></button>
          </span>
        </div>
      </div>
    </div>

    <!-- Diff modal — opens when a file row is clicked. -->
    <div v-if="diffOpen" class="diff-overlay">
      <div class="diff-modal">
        <div class="diff-header">
          <span class="diff-title">
            <span class="diff-file">{{ diffFile }}</span>
            <span class="diff-kind">{{ diffStaged ? "staged" : "unstaged" }}</span>
          </span>
          <button
            class="row-btn"
            @click="closeDiff"
            title="Close diff"
          ><X :size="14" /></button>
        </div>
        <div class="diff-body">
          <div v-if="diffLoading" class="diff-loading">Loading diff…</div>
          <pre v-else><div
              v-for="(line, idx) in diffLines"
              :key="idx"
              :class="diffLineClass(line)"
            >{{ line }}</div></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-tab {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  color: #d4d4d4;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
    sans-serif;
  overflow: auto;
  box-sizing: border-box;
}

.git-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  background: #252526;
  border-bottom: 1px solid #1a1a1a;
}

.branch-info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.branch-icon {
  color: #6fa8dc;
  flex-shrink: 0;
}

.branch-name {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ab-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #2d2d2e;
  border: 1px solid transparent;
}
.ab-ahead {
  color: #7bc97b;
  border-color: #355b3a;
}
.ab-behind {
  color: #e8b96d;
  border-color: #5c4824;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.git-btn {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 1;
}
.git-btn:hover:not(:disabled) {
  border-color: #396cd8;
  background: #333;
}
.git-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.git-btn.primary {
  background: #0a6cbd;
  color: #fff;
}
.git-btn.primary:hover:not(:disabled) {
  background: #0d80de;
}
.git-btn.ghost {
  background: transparent;
}

.repo-path {
  padding: 6px 14px;
  color: #888;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-flash {
  margin: 0 14px 6px 14px;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(123, 201, 123, 0.12);
  color: #b7e1b7;
  font-size: 12px;
}

.git-error {
  margin: 0 14px 6px 14px;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(229, 115, 115, 0.12);
  color: #f08a8a;
  font-size: 12px;
  white-space: pre-wrap;
}

.commit-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 14px 12px 14px;
  border-bottom: 1px solid #1a1a1a;
  flex: 0 0 auto;
}

.commit-msg {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
  min-height: 56px;
}
.commit-msg:focus {
  outline: none;
  border-color: #396cd8;
}

.section {
  flex: 0 0 auto;
  padding: 8px 0;
  border-bottom: 1px solid #1a1a1a;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 4px 14px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #cccccc;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.link-btn {
  background: transparent;
  border: none;
  color: #6fa8dc;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}
.link-btn:hover:not(:disabled) {
  text-decoration: underline;
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.section-empty {
  padding: 4px 14px 4px 14px;
  color: #777;
  font-size: 12px;
  font-style: italic;
}

.file-list {
  display: flex;
  flex-direction: column;
}

.file-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 3px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.file-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.file-badge {
  border: 1px solid;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  text-align: center;
  font-weight: 700;
  line-height: 1.5;
  display: inline-block;
  min-width: 18px;
}

.file-path {
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.file-path:hover {
  text-decoration: underline;
  color: #fff;
}

.file-old {
  color: #888;
  font-style: italic;
}

.file-actions {
  display: inline-flex;
  gap: 4px;
}

.row-btn {
  background: transparent;
  border: 1px solid #3a3a3a;
  color: #aaa;
  border-radius: 3px;
  padding: 1px 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  font-size: 11px;
}
.row-btn:hover:not(:disabled) {
  background: #333;
  color: #fff;
  border-color: #4a4a4a;
}
.row-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Diff modal: top-anchored, similar visual weight to the command palette. */
.diff-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  z-index: 1050;
}

.diff-modal {
  background: #252526;
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  width: 920px;
  max-width: 95vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
}

.diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #2d2d2e;
  border-bottom: 1px solid #1a1a1a;
}

.diff-title {
  display: inline-flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

.diff-file {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #d4d4d4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-kind {
  font-size: 10px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.diff-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.diff-body pre {
  margin: 0;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.diff-body div {
  padding: 0 12px;
  white-space: pre;
}
.diff-loading {
  padding: 20px;
  color: #888;
  text-align: center;
}

.diff-add { background: rgba(123, 201, 123, 0.12); color: #b7e1b7; }
.diff-del { background: rgba(229, 115, 115, 0.12); color: #f08a8a; }
.diff-meta { color: #888; }
.diff-hunk { color: #6fa8dc; background: rgba(111, 168, 220, 0.08); }
.diff-ctx { color: #d4d4d4; }
</style>
