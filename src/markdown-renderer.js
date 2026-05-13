// Markdown rendering for the side-by-side preview.
//
// Configuration:
//   - html: false       → ignore raw HTML in the source. Avoids the bulk of
//                         the v-html "trusted output" risk; even though
//                         Sparrow is a desktop app where the user owns the
//                         content, defense-in-depth is cheap here.
//   - linkify: true     → auto-link bare URLs.
//   - typographer: true → smart quotes / dashes.
//   - breaks: false     → stay CommonMark-y; a lone newline doesn't become
//                         <br>. Two-space line breaks and blank lines still
//                         work as expected.
//
// Extensions:
//   - highlight.js (`/lib/common`) for fenced-code-block syntax
//     highlighting. The "common" bundle covers ~35 mainstream languages
//     in ~150 KB minified — plenty for note-taking without paying for
//     COBOL and friends.
//   - markdown-it-task-lists for GitHub-style `[ ]` / `[x]` checkboxes.
//     Rendered disabled (read-only) so the preview stays a faithful
//     view of the source — toggling a checkbox in the preview would
//     diverge from the editor unless we plumbed source-mapping, which
//     is more complexity than this feature needs.

import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import taskLists from "markdown-it-task-lists";
import mermaid from "mermaid";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight: (str, lang) => {
    const tag = (lang || "").trim().toLowerCase();

    // Mermaid blocks become a placeholder div that mermaid.run() (called
    // by the parent component after Vue updates the DOM) replaces with
    // an SVG. We emit the raw source as the div's text content so
    // mermaid can find and re-parse it; v-html will set it via
    // innerHTML, which preserves the text. Escaping HTML-special
    // characters is critical here — without it, a `<` in the diagram
    // source would break out of the div.
    if (tag === "mermaid") {
      return (
        '<div class="mermaid">' +
        md.utils.escapeHtml(str) +
        "</div>"
      );
    }

    // Explicit language tag → ask highlight.js for that grammar.
    if (tag && hljs.getLanguage(tag)) {
      try {
        const out = hljs.highlight(str, {
          language: tag,
          ignoreIllegals: true,
        });
        return (
          '<pre class="hljs"><code class="language-' +
          tag +
          '">' +
          out.value +
          "</code></pre>"
        );
      } catch (_) {
        /* fall through to auto-detect */
      }
    }
    // Untagged or unknown language → let highlight.js guess.
    try {
      const auto = hljs.highlightAuto(str);
      return (
        '<pre class="hljs"><code>' + auto.value + "</code></pre>"
      );
    } catch (_) {
      // Final fallback: plain escaped code block.
      return (
        "<pre><code>" + md.utils.escapeHtml(str) + "</code></pre>"
      );
    }
  },
});

// Task-list plugin. `enabled: false` renders checkboxes as disabled
// inputs — clicks don't mutate them, which keeps preview state in lockstep
// with the editor source. `label: true` wraps the text in a <label> so the
// browser still applies the right accessibility semantics.
md.use(taskLists, { enabled: false, label: true });

/**
 * Render a markdown string to HTML. Empty / null input returns an empty
 * string so the preview pane goes blank cleanly.
 */
export function renderMarkdown(text) {
  if (!text) return "";
  return md.render(text);
}

// ---------------------------------------------------------------------------
// Mermaid post-render
// ---------------------------------------------------------------------------
//
// markdown-it's `highlight` hook is synchronous and mermaid's render API is
// async, so we use the two-phase pattern:
//
//   1. `renderMarkdown` emits `<div class="mermaid">…source…</div>`
//      for every ```mermaid block (handled in the highlight callback
//      above).
//   2. The parent component calls `renderMermaidIn(previewPaneEl)` once
//      Vue has flushed the updated HTML into the DOM. Mermaid scans
//      the container, parses each block's text content, and replaces
//      it with an inline `<svg>` diagram.
//
// Initialization is lazy on the first call so the ~600 KB mermaid bundle
// only loads when a preview actually contains a diagram (well, only when
// the user opens any markdown file with the preview pane active —
// `renderMermaidIn` runs unconditionally, but the import itself happens
// at module load time. Vite's dynamic import could split this further;
// not worth the complexity yet).

let mermaidReady = false;

function ensureMermaid() {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "strict",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  });
  mermaidReady = true;
}

/**
 * Process every `<div class="mermaid">` inside the given container,
 * replacing each one with the rendered SVG diagram. Safe to call on
 * containers with no mermaid blocks (no-op). Errors from individual
 * diagrams render inline so the rest of the preview keeps working.
 */
export async function renderMermaidIn(container) {
  if (!container) return;
  const nodes = container.querySelectorAll(
    "div.mermaid:not([data-processed='true'])"
  );
  if (nodes.length === 0) return;
  ensureMermaid();
  try {
    await mermaid.run({ nodes, suppressErrors: false });
  } catch (err) {
    console.warn("[mermaid] render failed:", err);
  }
}
