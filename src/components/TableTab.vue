<script setup>
// CSV / XLSX editor tab, backed by Tabulator (https://tabulator.info/).
//
// The parent passes a `tab` object that already carries the raw bytes (for
// xlsx) or the raw text (for csv). On mount we parse it into rows +
// columns, build a Tabulator instance, and start listening for cell edits
// so we can mark the tab dirty.
//
// The parent saves through the methods we expose on `defineExpose`:
//   - getData()    → array of plain row objects
//   - serialize()  → { kind: "text" | "binary", value } ready to write
//
// CSV parsing/serializing is small enough to do inline (no PapaParse
// dependency); XLSX goes through SheetJS for read and write.

import { ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { TabulatorFull as Tabulator } from "tabulator-tables";
// We import only the base Tabulator stylesheet, NOT one of its themes —
// the scoped overrides at the bottom of this file own the entire visual
// language so the grid matches the rest of Sparrow exactly.
import "tabulator-tables/dist/css/tabulator.min.css";
import * as XLSX from "xlsx";

const props = defineProps({
  // The owning tab object — we read `format` ("csv" | "xlsx"), `rawText`
  // (csv source), `rawBytes` (xlsx source).
  tab: { type: Object, required: true },
  active: { type: Boolean, default: false },
});
const emit = defineEmits(["dirty-changed"]);

const container = ref(null);
let table = null;
let disposed = false;

// --- CSV parser/serializer -------------------------------------------------
// Standards-compliant enough for the common cases: quoted fields with
// embedded commas / quotes (escaped as "") / newlines, plus CRLF tolerance.

function parseCSVText(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      // Skip stray trailing blank rows so we don't render phantom empties.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cur = "";
    } else if (c === '"' && cur === "") {
      inQuotes = true;
    } else {
      cur += c;
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => (h == null ? "" : String(h)));
  const dedupedHeaders = dedupeHeaders(headers);
  const data = rows.slice(1).map((arr) => {
    const obj = {};
    dedupedHeaders.forEach((h, i) => {
      obj[h] = arr[i] != null ? arr[i] : "";
    });
    return obj;
  });
  return { headers: dedupedHeaders, rows: data };
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n");
}

// --- XLSX parse/serialize via SheetJS --------------------------------------

function parseXLSXBytes(bytes) {
  if (!bytes || bytes.byteLength === 0)
    return { headers: [], rows: [] };
  const wb = XLSX.read(bytes, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { headers: [], rows: [] };
  // header:1 gives us rows-as-arrays so we keep ordering and can build the
  // header row exactly like the source file.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (aoa.length === 0) return { headers: [], rows: [] };
  const headers = dedupeHeaders(
    aoa[0].map((h) => (h == null ? "" : String(h)))
  );
  const rows = aoa.slice(1).map((arr) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = arr[i] != null ? arr[i] : "";
    });
    return obj;
  });
  return { headers, rows };
}

function serializeXLSX(headers, rows) {
  // json_to_sheet preserves the column order if we pass `header` explicitly.
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(bytes);
}

// Tabulator needs unique field names — collide them gracefully if the source
// file has duplicate header cells.
function dedupeHeaders(headers) {
  const seen = new Map();
  return headers.map((h) => {
    const base = h && h.length ? h : "(blank)";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

// --- Lifecycle -------------------------------------------------------------

onMounted(() => {
  if (disposed) return;
  let parsed;
  try {
    if (props.tab.format === "csv") {
      parsed = parseCSVText(props.tab.rawText || "");
    } else {
      parsed = parseXLSXBytes(props.tab.rawBytes || new Uint8Array());
    }
  } catch (err) {
    console.error("[TableTab] parse failed:", err);
    parsed = { headers: ["error"], rows: [{ error: String(err) }] };
  }

  // Always provide at least one column so the user has a starting grid even
  // for empty files.
  const headers =
    parsed.headers.length > 0 ? parsed.headers : ["A", "B", "C"];

  const columns = headers.map((h) => ({
    title: h,
    field: h,
    editor: "input",
    headerSort: true,
    headerFilter: "input",
    width: 160,
  }));

  table = new Tabulator(container.value, {
    data: parsed.rows,
    columns,
    layout: "fitDataStretch",
    height: "100%",
    movableColumns: true,
    history: true, // ctrl/cmd+Z inside the grid
    rowHeight: 28, // matches Sparrow's toolbar / tab-row baseline
    placeholder: "Empty sheet — click any cell to start typing.",
  });

  table.on("cellEdited", () => emit("dirty-changed", true));
  table.on("rowAdded", () => emit("dirty-changed", true));
  table.on("rowDeleted", () => emit("dirty-changed", true));
});

onBeforeUnmount(() => {
  disposed = true;
  if (table) {
    try {
      table.destroy();
    } catch (_) {
      /* ignore */
    }
    table = null;
  }
});

// When the tab becomes active again, Tabulator may need a redraw — its
// container can grow/shrink as the layout changes (split view etc).
watch(
  () => props.active,
  async (isActive) => {
    if (!isActive || !table) return;
    await nextTick();
    try {
      table.redraw(true);
    } catch (_) {
      /* ignore */
    }
  }
);

defineExpose({
  /** Returns the current rows as plain objects. */
  getData() {
    return table ? table.getData() : [];
  },
  /**
   * Returns the workbook serialized as either CSV text or XLSX bytes.
   * Caller picks the matching write API.
   */
  serialize() {
    if (!table) return { kind: "text", value: "" };
    const data = table.getData();
    const cols = table.getColumnDefinitions().map((c) => c.field);
    if (props.tab.format === "csv") {
      return { kind: "text", value: toCSV(cols, data) };
    }
    return { kind: "binary", value: serializeXLSX(cols, data) };
  },
});
</script>

<template>
  <div ref="container" class="tabulator-wrap"></div>
</template>

<style scoped>
.tabulator-wrap {
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  /* Sparrow toolbar/header have their own padding; the table fills the rest. */
}
</style>

<!--
  Tabulator dark-theme overrides — NON-SCOPED on purpose.

  Vue's `<style scoped>` rewrites every selector to include a per-component
  attribute (e.g. `.tabulator[data-v-abc123]`). Tabulator renders some of
  its UI (the edit list popup, certain drag indicators) into a portal /
  body-level container that doesn't carry the scope attribute, so scoped
  rules don't apply there. The base Tabulator stylesheet then wins, and
  light backgrounds + alternating rows leak through.

  Going non-scoped + prefixing every rule with `.tabulator` (or
  `.tabulator-…` for portals) is enough to keep the styles contained —
  nothing outside Tabulator uses those class names — and lets the rules
  apply everywhere Tabulator renders.

  Every color / background rule also carries `!important`, because
  Tabulator's bundled CSS uses fairly high specificity and we want
  predictable wins regardless of stylesheet load order.
-->
<style>
/* --- Root + body --- */

.tabulator {
  background: #1e1e1e !important;
  border: none !important;
  color: #d4d4d4 !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
    sans-serif;
  font-size: 13px;
}

.tabulator .tabulator-tableholder {
  background: #1e1e1e !important;
}

.tabulator .tabulator-tableholder .tabulator-placeholder {
  background: #1e1e1e !important;
  color: #888 !important;
  font-size: 12px;
}

/* --- Header --- */

.tabulator .tabulator-header {
  background: #252526 !important;
  border-bottom: 1px solid #1a1a1a !important;
  color: #d4d4d4 !important;
  font-weight: 600;
}

.tabulator .tabulator-header .tabulator-col {
  background: #252526 !important;
  border-right: 1px solid #1a1a1a !important;
  color: #d4d4d4 !important;
}

.tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover {
  background: #2d2d2d !important;
  cursor: pointer;
}

.tabulator .tabulator-header .tabulator-col .tabulator-col-content {
  padding: 5px 8px;
}

.tabulator
  .tabulator-header
  .tabulator-col
  .tabulator-col-content
  .tabulator-col-title {
  color: #d4d4d4 !important;
  font-size: 12px;
  font-weight: 600;
}

/* Sort arrows */
.tabulator
  .tabulator-header
  .tabulator-col.tabulator-sortable
  .tabulator-col-content
  .tabulator-col-sorter {
  color: #888 !important;
}

.tabulator
  .tabulator-header
  .tabulator-col.tabulator-sortable[aria-sort="ascending"]
  .tabulator-col-sorter,
.tabulator
  .tabulator-header
  .tabulator-col.tabulator-sortable[aria-sort="descending"]
  .tabulator-col-sorter {
  color: #4287d6 !important;
}

/* Header filter inputs */
.tabulator .tabulator-header .tabulator-col .tabulator-header-filter input {
  background: #1e1e1e !important;
  color: #d4d4d4 !important;
  border: 1px solid #2a2a2a !important;
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 12px;
  outline: none;
  font-family: inherit;
}

.tabulator
  .tabulator-header
  .tabulator-col
  .tabulator-header-filter
  input:focus {
  border-color: #4287d6 !important;
  background: #1a1a1a !important;
}

/* --- Rows --- */

/* Every row uses the same flat background — no zebra striping.
   The Tabulator base CSS targets `.tabulator-row-even` (and sometimes
   `.tabulator-row:nth-child(even)`) with a lighter color; we override
   both to the canonical row color and !important them so nothing else
   can re-introduce striping.

   IMPORTANT: do NOT set `min-height` or `display` on rows or cells —
   Tabulator positions them with inline-block + JS-computed widths.
   Overriding those properties breaks the column layout entirely
   (cells collapse into a single column). Height is driven by the
   `rowHeight` option in the Tabulator constructor instead. */
.tabulator .tabulator-row,
.tabulator .tabulator-row.tabulator-row-even,
.tabulator .tabulator-row.tabulator-row-odd,
.tabulator .tabulator-row:nth-child(even),
.tabulator .tabulator-row:nth-child(odd) {
  background: #1e1e1e !important;
  background-color: #1e1e1e !important;
  color: #d4d4d4 !important;
  border-bottom: 1px solid #232323 !important;
}

.tabulator .tabulator-row:hover {
  background: #2a2d2e !important;
}

.tabulator .tabulator-row.tabulator-selected {
  background: #094771 !important;
  color: #ffffff !important;
}

.tabulator .tabulator-row.tabulator-selected:hover {
  background: #0f5a8e !important;
}

/* --- Cells ---
   Tabulator lays cells out as `inline-block` and assigns each one a
   pixel width from JS. Don't override `display` here — it breaks the
   column layout. Vertical centering inside the 28 px row comes from a
   line-height that matches the content box (rowHeight − vertical
   padding) and `vertical-align: middle` on the inline-block flow. */
.tabulator .tabulator-row .tabulator-cell {
  background: transparent !important;
  color: inherit !important;
  border-right: 1px solid #232323 !important;
  padding: 0 8px;
  font-size: 12.5px;
  line-height: 28px;
  vertical-align: middle;
}

/* Active / editing cell — uses the same blue accent as Monaco focus.
   Keep the same outer padding as the resting cell so the blue ring
   doesn't visibly nudge the content. */
.tabulator .tabulator-row .tabulator-cell.tabulator-editing {
  background: #1a1a1a !important;
  border-color: #4287d6 !important;
  box-shadow: inset 0 0 0 1px #4287d6;
}

.tabulator .tabulator-row .tabulator-cell.tabulator-editing input,
.tabulator .tabulator-row .tabulator-cell.tabulator-editing textarea {
  background: transparent !important;
  color: #d4d4d4 !important;
  border: none !important;
  outline: none !important;
  font-family: inherit;
  font-size: inherit;
}

/* --- Edit popups (autocomplete lists, etc.) --- */

.tabulator-edit-list {
  background: #252526 !important;
  border: 1px solid #1a1a1a !important;
  color: #d4d4d4 !important;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
}

.tabulator-edit-list-item {
  color: #d4d4d4 !important;
  padding: 4px 10px;
  font-size: 12.5px;
}

.tabulator-edit-list-item:hover,
.tabulator-edit-list-item.active {
  background: #094771 !important;
  color: #ffffff !important;
}

/* --- Footer (pagination / counts, if enabled) --- */

.tabulator .tabulator-footer {
  background: #252526 !important;
  border-top: 1px solid #1a1a1a !important;
  color: #aaa !important;
  font-size: 11px;
  padding: 4px 8px;
}

.tabulator .tabulator-footer .tabulator-page {
  background: #2d2d2d !important;
  color: #d4d4d4 !important;
  border: 1px solid transparent !important;
  border-radius: 3px;
  padding: 2px 8px;
  margin: 0 1px;
  font-family: inherit;
}

.tabulator .tabulator-footer .tabulator-page:hover {
  border-color: #4287d6 !important;
}

.tabulator .tabulator-footer .tabulator-page.active {
  background: #094771 !important;
  color: #fff !important;
  border-color: #4287d6 !important;
}

/* --- Scrollbars (WebKit) --- */

.tabulator .tabulator-tableholder::-webkit-scrollbar,
.tabulator-edit-list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.tabulator .tabulator-tableholder::-webkit-scrollbar-track,
.tabulator-edit-list::-webkit-scrollbar-track {
  background: #1e1e1e;
}

.tabulator .tabulator-tableholder::-webkit-scrollbar-thumb,
.tabulator-edit-list::-webkit-scrollbar-thumb {
  background: #3a3a3a;
  border-radius: 4px;
}

.tabulator .tabulator-tableholder::-webkit-scrollbar-thumb:hover,
.tabulator-edit-list::-webkit-scrollbar-thumb:hover {
  background: #4a4a4a;
}

/* --- Column resize / drag --- */

.tabulator .tabulator-col-resize-handle {
  border-right: 1px solid transparent;
}

.tabulator .tabulator-col-resize-handle:hover {
  border-right-color: #4287d6;
}

.tabulator .tabulator-col.tabulator-moving {
  background: #2d2d2d !important;
  border: 1px dashed #4287d6 !important;
}
</style>
