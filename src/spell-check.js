// Promise-based wrapper around the spell-check web worker.
//
// We multiplex requests across a single worker using monotonic ids so that
// rapidly-typed documents don't spin up dozens of workers and the latest
// reply per id always finds its caller.

import SpellWorker from "./spell-check.worker.js?worker";

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new SpellWorker();
  worker.onmessage = (e) => {
    const { id, issues, error } = e.data || {};
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    if (error) cb.reject(new Error(error));
    else cb.resolve(issues || []);
  };
  worker.onerror = (e) => {
    // Don't crash the app on bundler issues — just log and let callers see
    // their pending Promises reject when the worker eventually replies (or
    // hang silently if it doesn't; spell check is non-essential).
    console.error("[spell-check] worker error:", e.message || e);
  };
  return worker;
}

/**
 * Run spell check against `text`, tagged with a `languageId` so the worker
 * knows how to mask non-prose regions (markdown code blocks, URLs, etc.).
 * Resolves with `[{text, offset, length, suggestions}]`.
 */
export function spellCheckText(text, languageId) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, text, languageId });
  });
}
