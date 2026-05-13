// Spell-check worker. Lives off the main thread so building the trie
// (~275k words) and running checks on long documents doesn't stutter the UI.
//
// Engine: cspell-trie-lib (the trie/dictionary core used by CSpell).
// Word list: `an-array-of-english-words` — a plain string[] of US English
// words that's easy to bundle into a worker.
//
// Protocol:
//   main -> worker:  { id, text, languageId }
//   worker -> main:  { id, issues } | { id, error }
//   each issue:      { text, offset, length, suggestions: string[] }

// Lazy trie construction. We delay both imports + build until the first
// check arrives, so the worker boots instantly when the app starts.
let triePromise = null;

async function getTrie() {
  if (triePromise) return triePromise;
  triePromise = (async () => {
    const [trieLib, wordsModule] = await Promise.all([
      import("cspell-trie-lib"),
      import("an-array-of-english-words"),
    ]);
    const words = wordsModule.default || wordsModule;

    // cspell-trie-lib has evolved over the major versions, so try the few
    // entry points it has shipped. The first one that exists wins.
    if (typeof trieLib.buildTrie === "function") {
      return trieLib.buildTrie(words);
    }
    if (typeof trieLib.buildITrieFromWords === "function") {
      return trieLib.buildITrieFromWords(words);
    }
    if (trieLib.Trie && typeof trieLib.Trie.create === "function") {
      return trieLib.Trie.create(words);
    }
    throw new Error(
      "cspell-trie-lib: no recognized trie builder found in this version"
    );
  })();
  return triePromise;
}

// Mask out regions that aren't prose so we don't flag URLs, code, etc.
// Whitespace is substituted (rather than removed) so that offsets back into
// the original text stay correct.
function maskNonProse(text, languageId) {
  let out = text;
  if (languageId === "markdown") {
    // Fenced code blocks ``` ... ```
    out = out.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
    // Inline code `foo`
    out = out.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
    // Images ![alt](url) — keep alt text, mask the URL portion
    out = out.replace(
      /!\[([^\]]*)\]\(([^)]*)\)/g,
      (m, alt) => alt + " ".repeat(Math.max(0, m.length - alt.length))
    );
    // Links [label](url) — keep label, mask URL
    out = out.replace(
      /\[([^\]]*)\]\(([^)]*)\)/g,
      (m, label) => label + " ".repeat(Math.max(0, m.length - label.length))
    );
  }
  // Bare URLs everywhere.
  out = out.replace(/https?:\/\/\S+/g, (m) => " ".repeat(m.length));
  // Email addresses.
  out = out.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, (m) =>
    " ".repeat(m.length)
  );
  return out;
}

// Matches normal English words including apostrophes ("don't", "it's").
const WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)*/g;

function shouldCheckWord(word) {
  if (word.length < 3) return false;
  // ACRONYMS like NASA, HTTP — leave them alone.
  if (/^[A-Z]+$/.test(word)) return false;
  // Words with digits are almost always identifiers.
  if (/\d/.test(word)) return false;
  // camelCase / PascalCase / arbitraryMixed — code-ish, skip.
  if (/[A-Z]/.test(word.slice(1))) return false;
  return true;
}

function normalizeSuggestions(raw) {
  if (!raw) return [];
  return raw
    .slice(0, 5)
    .map((s) => (typeof s === "string" ? s : s.word || s.text || ""))
    .filter(Boolean);
}

async function checkText(text, languageId) {
  const trie = await getTrie();
  const masked = maskNonProse(text, languageId);
  const issues = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(masked))) {
    const word = m[0];
    if (!shouldCheckWord(word)) continue;
    // Cheap match attempts: original casing then lowercase.
    if (trie.has(word) || trie.has(word.toLowerCase())) continue;
    let suggestions = [];
    try {
      suggestions = normalizeSuggestions(trie.suggest(word, 5));
    } catch (_) {
      /* suggestions are nice-to-have; ignore failures */
    }
    issues.push({
      text: word,
      offset: m.index,
      length: word.length,
      suggestions,
    });
    // Cap to keep marker rendering snappy on huge files.
    if (issues.length >= 500) break;
  }
  return issues;
}

self.onmessage = async (e) => {
  const { id, text, languageId } = e.data || {};
  if (id == null) return;
  try {
    const issues = await checkText(text || "", languageId || "plaintext");
    self.postMessage({ id, issues });
  } catch (err) {
    self.postMessage({
      id,
      error: String((err && err.message) || err),
    });
  }
};
