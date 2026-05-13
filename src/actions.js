// Quick-action persistence.
//
// An action is `{ id, name, type, command, scriptPath, args, description,
// createdAt }`. `type` is "shell" or "python":
//   - shell:  `command` is run in a new terminal tab (template-substituted).
//   - python: `scriptPath` is invoked with `args` (also template-
//             substituted) and the editor's selection on stdin; its stdout
//             replaces the selection.
//
// Both flavors expand the same template variables:
//   {file}      – full path of the active editor tab's saved file
//   {dir}       – directory portion of {file}, or the explorer's folder
//   {filename}  – basename (file + ext) of {file}
//   {basename}  – {filename} without the trailing extension
//   {ext}       – extension without the leading dot
//   {selection} – current text selection in the editor, if any
//
// Stored as a single JSON array in localStorage. Same shape as the snippets
// store on purpose — both are essentially named text blobs with metadata.

const STORAGE_KEY = "sparrow.actions.v1";

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
    console.warn("[actions] save failed:", err);
  }
}

function nextId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function getActions() {
  return readAll();
}

export function saveAction({
  name,
  type,
  command,
  scriptPath,
  args,
  description,
}) {
  const list = readAll();
  const item = {
    id: nextId(),
    name: (name || "Untitled action").trim(),
    // Default to shell so anything passing only `command` keeps working.
    type: type === "python" ? "python" : "shell",
    command: command || "",
    scriptPath: scriptPath || "",
    args: args || "",
    description: (description || "").trim(),
    createdAt: Date.now(),
  };
  list.unshift(item);
  writeAll(list);
  return item;
}

export function deleteAction(id) {
  writeAll(readAll().filter((a) => a.id !== id));
}

export function updateAction(id, updates) {
  writeAll(readAll().map((a) => (a.id === id ? { ...a, ...updates } : a)));
}
