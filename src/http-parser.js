// Parser for `.http` / `.rest` files (compatible with the VS Code REST Client
// format for the common cases).
//
// What it understands:
//   - `###` lines split the file into request blocks. Text after `###` on the
//     same line becomes the block's display name.
//   - `#` and `//` are line comments.
//   - `@name = value` lines declare file-level variables (anywhere in the file).
//   - `{{name}}` placeholders substitute variables (with cross-references
//     resolved up to a small recursion depth).
//   - First non-comment, non-blank, non-`@` line of a block is the request
//     line: `METHOD URL [HTTP/version]`.
//   - Subsequent `Name: Value` lines are headers.
//   - A blank line ends headers; everything after it (until block end) is the
//     request body.
//
// What it deliberately skips:
//   - System variables like `{{$timestamp}}` or `{{$randomInt}}` — these are
//     left as-is in the output.
//   - Inline file references (`< ./body.json`).
//   - Request-variables that reference previous responses.
//   - Environment files.

const VAR_RE = /\{\{([^}]+)\}\}/g;

/**
 * Pull every `@name = value` declaration out of the file and resolve any
 * cross-references between them. Returns a `{ name: value }` map of fully
 * resolved strings.
 */
export function extractAndResolveVars(text) {
  const raw = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const m = /^@([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (m) raw[m[1]] = m[2].trim();
  }
  const resolved = { ...raw };
  // Iterate a few times to resolve chains. 5 passes covers most real-world
  // configurations without risking pathological inputs.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const k of Object.keys(resolved)) {
      const next = resolved[k].replace(VAR_RE, (whole, key) => {
        const t = key.trim();
        return resolved[t] !== undefined ? resolved[t] : whole;
      });
      if (next !== resolved[k]) {
        resolved[k] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return resolved;
}

function substitute(text, vars) {
  if (text == null) return text;
  return text.replace(VAR_RE, (whole, key) => {
    const t = key.trim();
    return vars[t] !== undefined ? vars[t] : whole;
  });
}

function isCommentOrBlank(line) {
  return /^\s*$/.test(line) || /^\s*(?:#(?!##)|\/\/)/.test(line);
}

function isVarDecl(line) {
  return /^@[\w.-]+\s*=/.test(line);
}

/**
 * Parse the contents of a single block (the lines between two `###`
 * separators or between the file start/end and a separator). Returns null
 * when the block doesn't contain a recognizable request.
 */
function parseBlock(blockLines, baseLine, vars) {
  let i = 0;
  // Skip leading comments / blank lines / variable decls.
  while (i < blockLines.length) {
    const l = blockLines[i];
    if (isCommentOrBlank(l) || isVarDecl(l)) {
      i++;
      continue;
    }
    break;
  }
  if (i >= blockLines.length) return null;

  const reqLineIdx = i;
  const reqLine = blockLines[i];
  const reqMatch =
    /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(reqLine);
  if (!reqMatch) return null;
  const method = reqMatch[1].toUpperCase();
  const url = substitute(reqMatch[2], vars);
  i++;

  // Headers run until a blank line or end of block.
  const headers = [];
  while (i < blockLines.length) {
    const l = blockLines[i];
    if (/^\s*$/.test(l)) {
      i++;
      break;
    }
    if (/^\s*(?:#|\/\/)/.test(l)) {
      i++;
      continue;
    }
    const hMatch = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(l);
    if (!hMatch) {
      // First non-header line ends the header section; treat remaining as body.
      break;
    }
    headers.push([hMatch[1], substitute(hMatch[2], vars)]);
    i++;
  }

  // Everything left is body. Trim trailing blank lines.
  let bodyLines = blockLines.slice(i);
  while (bodyLines.length && /^\s*$/.test(bodyLines[bodyLines.length - 1])) {
    bodyLines.pop();
  }
  const body =
    bodyLines.length > 0 ? substitute(bodyLines.join("\n"), vars) : null;

  return {
    method,
    url,
    headers,
    body,
    requestLine: baseLine + reqLineIdx,
    startLine: baseLine,
    endLine: baseLine + blockLines.length - 1,
  };
}

/**
 * Parse a full `.http` document. Returns `{ fileVars, requests }`.
 *
 * Each request has 0-based line ranges (`startLine`, `endLine`,
 * `requestLine`) so the UI can highlight or jump to it.
 */
export function parseHttp(text) {
  const fileVars = extractAndResolveVars(text);
  const lines = text.split("\n");

  const blocks = [];
  let curStart = 0;
  let curLines = [];
  let curName = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sep = /^###\s*(.*)$/.exec(line);
    if (sep) {
      if (curLines.length > 0) {
        blocks.push({ start: curStart, lines: curLines, name: curName });
      }
      curStart = i + 1;
      curLines = [];
      curName = sep[1].trim();
    } else {
      curLines.push(line);
    }
  }
  if (curLines.length > 0) {
    blocks.push({ start: curStart, lines: curLines, name: curName });
  }

  const requests = [];
  for (const b of blocks) {
    const parsed = parseBlock(b.lines, b.start, fileVars);
    if (parsed) requests.push({ ...parsed, name: b.name });
  }
  return { fileVars, requests };
}

/**
 * Given the editor text and the 1-based cursor line, return the request the
 * cursor is currently inside — or the first request as a fallback.
 */
export function findRequestAtCursor(text, cursorLine1Based) {
  const { requests } = parseHttp(text);
  if (requests.length === 0) return null;
  const idx = (cursorLine1Based || 1) - 1;
  for (const r of requests) {
    if (idx >= r.startLine && idx <= r.endLine) return r;
  }
  return requests[0];
}
