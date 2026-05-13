// Persistent code-snippet store.
//
// A snippet is `{ id, name, type, content, description, language,
// createdAt }`. `type` is one of:
//   - "text"   — `content` is pasted at the cursor / replaces the
//                selection (the original behavior).
//   - "prompt" — `content` is run as an AI instruction; the current
//                selection (if any) is included as context and the AI's
//                reply replaces it.
//
// The whole collection lives as a single JSON blob in localStorage so we
// don't need any backend wiring — fine for a single-user desktop app, and
// trivial to migrate to a Rust-backed file later if multi-window sync ever
// matters.

const STORAGE_KEY = "sparrow.snippets.v1";

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {
    /* corrupted JSON — start fresh */
  }
  return [];
}

function writeAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[snippets] save failed:", err);
  }
}

function nextId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  );
}

/** Returns all snippets, newest first. */
export function getSnippets() {
  return readAll();
}

/** Persists a new snippet and returns it (with its assigned id). */
export function saveSnippet({ name, content, description, language, type }) {
  const list = readAll();
  const item = {
    id: nextId(),
    name: (name || "Untitled snippet").trim(),
    // Default to "text" so any pre-existing saved snippets (or callers
    // that haven't been updated yet) keep their original behavior.
    type: type === "prompt" ? "prompt" : "text",
    content: content || "",
    description: (description || "").trim(),
    language: language || "",
    createdAt: Date.now(),
  };
  list.unshift(item); // newest first feels right in a picker
  writeAll(list);
  return item;
}

export function deleteSnippet(id) {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function updateSnippet(id, updates) {
  writeAll(
    readAll().map((s) => (s.id === id ? { ...s, ...updates } : s))
  );
}
