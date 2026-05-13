<script setup>
// Whiteboard tab — Fabric.js canvas with a small built-in toolbar.
//
// Drawing tools: select / free-hand pen / eraser / rectangle / circle /
// line / text. Stroke color and width are shared between the pen, eraser,
// and inserted shapes.
//
// Persistence: `canvas.toJSON()` round-trips the board to JSON; the
// parent wraps it in a `.sbw` file and writes through plugin-fs. Loading
// is a single `canvas.loadFromJSON()` call.
//
// Export: PNG (via `canvas.toDataURL`), SVG (via `canvas.toSVG`), PDF
// (jsPDF wrapping the PNG). Each opens a save dialog directly so the
// parent doesn't need to know about export formats.

import {
  ref,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick,
} from "vue";
import {
  Canvas,
  Rect,
  Ellipse,
  Line as FabLine,
  IText,
  PencilBrush,
} from "fabric";
import { jsPDF } from "jspdf";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";

import {
  MousePointer2,
  PencilLine,
  Eraser,
  Square,
  Circle as CircleIcon,
  Minus,
  Type,
  Trash2,
  PaintBucket,
} from "lucide-vue-next";

const props = defineProps({
  tab: { type: Object, required: true },
  active: { type: Boolean, default: false },
});
const emit = defineEmits(["dirty-changed"]);

const containerRef = ref(null);
const canvasEl = ref(null);

const tool = ref("select"); // select | pen | eraser
const color = ref("#ffffff");
const bgColor = ref("#1e1e1e");
const strokeWidth = ref(2);

let canvas = null;
let resizeObserver = null;
let disposed = false;

// --- Tool / brush switching -------------------------------------------------

function applyTool(t) {
  tool.value = t;
  if (!canvas) return;
  const isFreehand = t === "pen" || t === "eraser";
  canvas.isDrawingMode = isFreehand;
  if (!isFreehand) return;
  const brush = new PencilBrush(canvas);
  if (t === "pen") {
    brush.color = color.value;
    brush.width = strokeWidth.value;
  } else {
    // Lightweight "eraser": paint with the current background color. A
    // real eraser would remove pixels under the cursor; this approach is
    // good enough for a whiteboard and avoids per-stroke object
    // hit-testing.
    brush.color = bgColor.value;
    brush.width = Math.max(8, strokeWidth.value * 5);
  }
  canvas.freeDrawingBrush = brush;
}

function applyBackgroundColor() {
  if (!canvas) return;
  canvas.backgroundColor = bgColor.value;
  canvas.requestRenderAll();
  // Re-build the eraser brush so subsequent strokes "erase" against the
  // new background instead of the old one.
  if (tool.value === "eraser") applyTool("eraser");
  emit("dirty-changed", true);
}

// --- Shape inserts ---------------------------------------------------------

function addShape(kind) {
  if (!canvas) return;
  applyTool("select"); // newly inserted shape should be immediately movable
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const stroke = color.value;
  const sw = strokeWidth.value;
  let obj = null;
  if (kind === "rect") {
    obj = new Rect({
      left: cx - 60,
      top: cy - 35,
      width: 120,
      height: 70,
      fill: "transparent",
      stroke,
      strokeWidth: sw,
    });
  } else if (kind === "circle") {
    obj = new Ellipse({
      left: cx - 55,
      top: cy - 40,
      rx: 55,
      ry: 40,
      fill: "transparent",
      stroke,
      strokeWidth: sw,
    });
  } else if (kind === "line") {
    obj = new FabLine([cx - 60, cy, cx + 60, cy], {
      stroke,
      strokeWidth: sw,
    });
  } else if (kind === "text") {
    obj = new IText("Text", {
      left: cx - 20,
      top: cy - 12,
      fontSize: 22,
      fill: color.value,
      fontFamily: "system-ui, sans-serif",
    });
  }
  if (obj) {
    canvas.add(obj);
    canvas.setActiveObject(obj);
    canvas.requestRenderAll();
  }
}

// --- Selection / clear -----------------------------------------------------

function deleteSelected() {
  if (!canvas) return;
  const active = canvas.getActiveObject();
  if (!active) return;
  // If a text object is being edited, let the keystroke fall through to
  // the input instead of nuking the object.
  if (active.isEditing) return;
  const items = canvas.getActiveObjects();
  items.forEach((o) => canvas.remove(o));
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}

function clearAll() {
  if (!canvas) return;
  if (!window.confirm("Clear the entire whiteboard?")) return;
  canvas.clear();
  canvas.backgroundColor = bgColor.value;
  canvas.requestRenderAll();
  emit("dirty-changed", true);
}

// --- Export ----------------------------------------------------------------

function dataUrlToBytes(url) {
  const base64 = url.split(",")[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function exportTo(format) {
  if (!canvas) return;
  const stem = (props.tab.filename || "whiteboard").replace(/\.sbw$/, "");
  const defaultName = `${stem}.${format}`;
  try {
    const chosen = await saveDialog({
      title: `Export ${format.toUpperCase()}`,
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!chosen) return;

    if (format === "svg") {
      const svg = canvas.toSVG();
      await writeTextFile(chosen, svg);
    } else if (format === "png") {
      const dataUrl = canvas.toDataURL({ format: "png", multiplier: 2 });
      await writeFile(chosen, dataUrlToBytes(dataUrl));
    } else if (format === "pdf") {
      const w = canvas.width;
      const h = canvas.height;
      const dataUrl = canvas.toDataURL({ format: "png", multiplier: 2 });
      const pdf = new jsPDF({
        orientation: w > h ? "landscape" : "portrait",
        unit: "pt",
        format: [w, h],
      });
      pdf.addImage(dataUrl, "PNG", 0, 0, w, h);
      const bytes = new Uint8Array(pdf.output("arraybuffer"));
      await writeFile(chosen, bytes);
    }
  } catch (err) {
    console.error("[whiteboard] export failed:", err);
  }
}

// --- Resize / lifecycle ----------------------------------------------------

function syncCanvasSize() {
  if (!canvas || !containerRef.value) return;
  const w = containerRef.value.clientWidth;
  const h = containerRef.value.clientHeight;
  if (w > 0 && h > 0) {
    canvas.setDimensions({ width: w, height: h });
    canvas.requestRenderAll();
  }
}

function onKeyDown(e) {
  if (!props.active || !canvas) return;
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  // Don't interfere with text editing or with form fields outside the canvas.
  const target = e.target;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  ) {
    return;
  }
  const active = canvas.getActiveObject();
  if (active && !active.isEditing) {
    e.preventDefault();
    deleteSelected();
  }
}

onMounted(async () => {
  await nextTick();
  if (disposed) return;

  canvas = new Canvas(canvasEl.value, {
    backgroundColor: bgColor.value,
    selection: true,
    preserveObjectStacking: true,
    width: containerRef.value.clientWidth || 800,
    height: containerRef.value.clientHeight || 600,
  });

  if (props.tab.boardJson) {
    try {
      await canvas.loadFromJSON(props.tab.boardJson);
      // Sync the toolbar swatch with whatever color the file shipped with.
      // If the file predates the bg-color feature it'll have whatever
      // Fabric set as default — fall back to our own default.
      if (
        typeof canvas.backgroundColor === "string" &&
        canvas.backgroundColor
      ) {
        bgColor.value = canvas.backgroundColor;
      } else {
        canvas.backgroundColor = bgColor.value;
      }
      canvas.requestRenderAll();
    } catch (err) {
      console.error("[whiteboard] loadFromJSON failed:", err);
    }
  }

  const markDirty = () => emit("dirty-changed", true);
  canvas.on("object:added", markDirty);
  canvas.on("object:modified", markDirty);
  canvas.on("object:removed", markDirty);
  canvas.on("path:created", markDirty);

  applyTool(tool.value);

  resizeObserver = new ResizeObserver(syncCanvasSize);
  resizeObserver.observe(containerRef.value);

  document.addEventListener("keydown", onKeyDown);
});

onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("keydown", onKeyDown);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (canvas) {
    try {
      canvas.dispose();
    } catch (_) {
      /* ignore */
    }
    canvas = null;
  }
});

// Re-fit + refresh the canvas when this tab becomes active again — its
// container may have grown / shrunk while hidden.
watch(
  () => props.active,
  async (isActive) => {
    if (!isActive || !canvas) return;
    await nextTick();
    syncCanvasSize();
  }
);

defineExpose({
  /** Returns the current board as a Fabric.js JSON object. */
  getBoardJson() {
    return canvas ? canvas.toJSON() : null;
  },
});
</script>

<template>
  <div class="wb-shell">
    <div class="wb-toolbar">
      <button
        class="wb-btn"
        :class="{ on: tool === 'select' }"
        @click="applyTool('select')"
        title="Select / Move"
      ><MousePointer2 :size="14" /></button>
      <button
        class="wb-btn"
        :class="{ on: tool === 'pen' }"
        @click="applyTool('pen')"
        title="Pen (free-hand)"
      ><PencilLine :size="14" /></button>
      <button
        class="wb-btn"
        :class="{ on: tool === 'eraser' }"
        @click="applyTool('eraser')"
        title="Eraser"
      ><Eraser :size="14" /></button>

      <span class="wb-sep"></span>

      <button
        class="wb-btn"
        @click="addShape('rect')"
        title="Rectangle"
      ><Square :size="14" /></button>
      <button
        class="wb-btn"
        @click="addShape('circle')"
        title="Circle / Ellipse"
      ><CircleIcon :size="14" /></button>
      <button
        class="wb-btn"
        @click="addShape('line')"
        title="Line"
      ><Minus :size="14" /></button>
      <button
        class="wb-btn"
        @click="addShape('text')"
        title="Text"
      ><Type :size="14" /></button>

      <span class="wb-sep"></span>

      <label class="wb-color-group" title="Stroke color">
        <PencilLine :size="11" class="wb-color-marker" />
        <input
          type="color"
          v-model="color"
          @change="applyTool(tool)"
          class="wb-color"
          aria-label="Stroke color"
        />
      </label>
      <label class="wb-color-group" title="Background color">
        <PaintBucket :size="11" class="wb-color-marker" />
        <input
          type="color"
          v-model="bgColor"
          @change="applyBackgroundColor"
          class="wb-color"
          aria-label="Background color"
        />
      </label>
      <select
        v-model.number="strokeWidth"
        @change="applyTool(tool)"
        class="wb-stroke"
        title="Stroke width"
      >
        <option :value="1">1 px</option>
        <option :value="2">2 px</option>
        <option :value="4">4 px</option>
        <option :value="8">8 px</option>
        <option :value="16">16 px</option>
      </select>

      <span class="wb-sep"></span>

      <button
        class="wb-btn"
        @click="deleteSelected"
        title="Delete selection"
      ><Trash2 :size="14" /></button>
      <button class="wb-btn wb-text-btn" @click="clearAll" title="Clear all">
        Clear
      </button>

      <div class="wb-spacer"></div>

      <button
        class="wb-btn wb-text-btn"
        @click="exportTo('png')"
        title="Export as PNG"
      >PNG</button>
      <button
        class="wb-btn wb-text-btn"
        @click="exportTo('svg')"
        title="Export as SVG"
      >SVG</button>
      <button
        class="wb-btn wb-text-btn"
        @click="exportTo('pdf')"
        title="Export as PDF"
      >PDF</button>
    </div>

    <div ref="containerRef" class="wb-canvas-wrap">
      <canvas ref="canvasEl"></canvas>
    </div>
  </div>
</template>

<style scoped>
.wb-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  box-sizing: border-box;
}

.wb-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: #252526;
  border-bottom: 1px solid #1a1a1a;
}

.wb-btn {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  min-width: 28px;
  min-height: 26px;
  box-shadow: none;
}

.wb-btn.wb-text-btn {
  line-height: 1;
  padding: 5px 10px;
}

.wb-btn:hover {
  border-color: #396cd8;
  background: #333;
}

.wb-btn.on {
  background: #1f3850;
  color: #cce4ff;
  border-color: #4287d6;
}

.wb-sep {
  width: 1px;
  height: 18px;
  background: #1a1a1a;
  margin: 0 4px;
}

.wb-color {
  width: 28px;
  height: 26px;
  border: 1px solid #1a1a1a;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  padding: 0;
}

.wb-color-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 2px;
  cursor: pointer;
}

.wb-color-marker {
  color: #888;
}

.wb-stroke {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  height: 26px;
}

.wb-spacer {
  flex: 1;
}

.wb-canvas-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: #1e1e1e;
}
</style>
