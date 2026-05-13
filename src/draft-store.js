// Autosave / draft store.
//
// Every dirty editor / table / whiteboard tab periodically snapshots its
// state into `$APPLOCALDATA/drafts/<draftKey>.json`. On startup we scan the
// folder and offer to restore each draft as a new tab. Drafts are deleted
// once the user successfully saves the tab to its real location (or
// explicitly discards them in the recovery modal).
//
// Each draft is a JSON envelope:
//   {
//     draftKey, kind, filename, filePath,
//     savedAt,
//     payload: { ... }  // shape depends on kind
//   }

import {
  writeTextFile,
  readTextFile,
  readDir,
  remove,
  mkdir,
  exists,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";

const DIR = "drafts";
const BASE = { baseDir: BaseDirectory.AppLocalData };

async function ensureDir() {
  try {
    const present = await exists(DIR, BASE);
    if (!present) {
      await mkdir(DIR, { ...BASE, recursive: true });
    }
  } catch (err) {
    // Some permission setups make `exists` itself throw; mkdir with
    // recursive=true is idempotent so we can fall through.
    try {
      await mkdir(DIR, { ...BASE, recursive: true });
    } catch (e2) {
      console.warn("[drafts] ensureDir failed:", e2);
    }
  }
}

function pathFor(key) {
  return `${DIR}/${key}.json`;
}

export async function writeDraft(draft) {
  if (!draft || !draft.draftKey) return;
  await ensureDir();
  await writeTextFile(pathFor(draft.draftKey), JSON.stringify(draft), BASE);
}

export async function readAllDrafts() {
  try {
    await ensureDir();
    const entries = await readDir(DIR, BASE);
    const out = [];
    for (const e of entries || []) {
      const name = e.name;
      if (!name || !name.endsWith(".json")) continue;
      try {
        const text = await readTextFile(`${DIR}/${name}`, BASE);
        const parsed = JSON.parse(text);
        if (parsed && parsed.draftKey) out.push(parsed);
      } catch (err) {
        console.warn(`[drafts] could not read ${name}:`, err);
      }
    }
    // Newest first
    out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return out;
  } catch (err) {
    console.warn("[drafts] readAll failed:", err);
    return [];
  }
}

export async function deleteDraft(key) {
  if (!key) return;
  try {
    await remove(pathFor(key), BASE);
  } catch (err) {
    // Already gone is fine.
    if (!/no such file|not found/i.test(String(err))) {
      console.warn(`[drafts] delete ${key} failed:`, err);
    }
  }
}

export async function clearAllDrafts() {
  const all = await readAllDrafts();
  for (const d of all) await deleteDraft(d.draftKey);
}
