<script setup>
// Read-only preview tab for images, SVG, and PDF.
//
// We wrap the raw bytes from disk in a Blob, mint an object URL, and hand
// it to either `<img>` (raster images + SVG) or `<iframe>` (PDF). Tauri's
// WebView renders PDFs natively, so no extra dependency is needed.
//
// Image tabs get a small toolbar: zoom in / out, "fit", "1:1", and a
// percent indicator. PDF tabs delegate everything to the embedded viewer.

import {
  ref,
  computed,
  onMounted,
  onBeforeUnmount,
  watch,
} from "vue";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  ExternalLink,
} from "lucide-vue-next";
import { openPath } from "@tauri-apps/plugin-opener";

const props = defineProps({
  tab: { type: Object, required: true },
  active: { type: Boolean, default: false },
});

const imgEl = ref(null);
const objectUrl = ref(null);
const naturalSize = ref({ width: 0, height: 0 });

// View state, image-only.
const zoom = ref(1);
const fit = ref(true);

const mimeType = computed(() => {
  switch (props.tab.format) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "tiff":
    case "tif":
      return "image/tiff";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
});

const isPdf = computed(() => props.tab.format === "pdf");

function buildUrl() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value);
    objectUrl.value = null;
  }
  const bytes = props.tab.rawBytes;
  if (!bytes) return;
  const blob = new Blob([bytes], { type: mimeType.value });
  objectUrl.value = URL.createObjectURL(blob);
}

function onImageLoad() {
  const el = imgEl.value;
  if (!el) return;
  naturalSize.value = {
    width: el.naturalWidth,
    height: el.naturalHeight,
  };
}

const imgStyle = computed(() => {
  if (fit.value) {
    return {
      maxWidth: "100%",
      maxHeight: "100%",
      objectFit: "contain",
    };
  }
  if (!naturalSize.value.width) return {};
  return {
    width: `${naturalSize.value.width * zoom.value}px`,
    height: `${naturalSize.value.height * zoom.value}px`,
    maxWidth: "none",
    maxHeight: "none",
  };
});

function zoomIn() {
  zoom.value = Math.min(zoom.value * 1.25, 16);
  fit.value = false;
}
function zoomOut() {
  zoom.value = Math.max(zoom.value / 1.25, 0.05);
  fit.value = false;
}
function fitToScreen() {
  zoom.value = 1;
  fit.value = true;
}
function actualSize() {
  zoom.value = 1;
  fit.value = false;
}

// Hand the file off to the OS's default application. Especially useful for
// PDFs on Linux, where WebKit2GTK doesn't render them inline reliably —
// users still get to view them in their system viewer with one click.
async function openExternally() {
  const path = props.tab.filePath;
  if (!path) return;
  try {
    await openPath(path);
  } catch (err) {
    console.warn("[preview] open externally failed:", err);
  }
}

onMounted(() => {
  buildUrl();
});

onBeforeUnmount(() => {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
});

// If the file is re-loaded (e.g. external edit + reopen), rebuild the URL.
watch(
  () => props.tab.rawBytes,
  () => buildUrl()
);
</script>

<template>
  <div class="pv-shell">
    <!--
      Toolbar:
        - Image / SVG previews get the full zoom set + open-externally.
        - PDF previews get a slim header with only open-externally (the
          embedded viewer has its own zoom / page controls).
    -->
    <div class="pv-toolbar" v-if="!isPdf">
      <button class="pv-btn" @click="zoomOut" title="Zoom out">
        <ZoomOut :size="14" />
      </button>
      <button class="pv-btn" @click="zoomIn" title="Zoom in">
        <ZoomIn :size="14" />
      </button>
      <button
        class="pv-btn"
        @click="fitToScreen"
        :class="{ on: fit }"
        title="Fit to window"
      ><Maximize2 :size="14" /></button>
      <button
        class="pv-btn pv-text-btn"
        @click="actualSize"
        :class="{ on: !fit && zoom === 1 }"
        title="Actual size (100%)"
      >1:1</button>
      <button
        class="pv-btn"
        @click="fitToScreen"
        title="Reset"
      ><RotateCcw :size="14" /></button>
      <span class="pv-info">{{ Math.round(zoom * 100) }}%</span>
      <span class="pv-info pv-dim" v-if="naturalSize.width">
        · {{ naturalSize.width }} × {{ naturalSize.height }}
      </span>
      <div class="pv-spacer"></div>
      <button
        v-if="tab.filePath"
        class="pv-btn"
        @click="openExternally"
        title="Open in system default app"
      ><ExternalLink :size="14" /></button>
    </div>
    <div class="pv-toolbar pv-toolbar-slim" v-else>
      <span class="pv-info pv-dim">PDF</span>
      <div class="pv-spacer"></div>
      <button
        v-if="tab.filePath"
        class="pv-btn pv-text-btn"
        @click="openExternally"
        title="Open in system default app (recommended on Linux)"
      ><ExternalLink :size="13" /> Open externally</button>
    </div>

    <div class="pv-canvas">
      <iframe
        v-if="isPdf && objectUrl"
        :src="objectUrl"
        class="pv-pdf"
        title="PDF preview"
      ></iframe>
      <img
        v-else-if="objectUrl"
        ref="imgEl"
        :src="objectUrl"
        :style="imgStyle"
        class="pv-image"
        @load="onImageLoad"
        alt=""
      />
      <div v-else class="pv-empty">No preview data.</div>
    </div>
  </div>
</template>

<style scoped>
.pv-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
  box-sizing: border-box;
}

.pv-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: #252526;
  border-bottom: 1px solid #1a1a1a;
}

.pv-btn {
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

.pv-btn.pv-text-btn {
  line-height: 1;
  padding: 5px 10px;
}

.pv-btn:hover {
  border-color: #396cd8;
  background: #333;
}

.pv-btn.on {
  background: #1f3850;
  color: #cce4ff;
  border-color: #4287d6;
}

.pv-info {
  margin-left: 6px;
  color: #cccccc;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.pv-info.pv-dim {
  color: #888;
  margin-left: 0;
}

.pv-spacer {
  flex: 1;
}

.pv-toolbar-slim {
  min-height: 28px;
}

.pv-canvas {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Checkered "transparency" background so PNGs with alpha read correctly. */
  background-color: #1e1e1e;
  background-image:
    linear-gradient(45deg, #262626 25%, transparent 25%),
    linear-gradient(-45deg, #262626 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #262626 75%),
    linear-gradient(-45deg, transparent 75%, #262626 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, 10px 0;
}

.pv-image {
  display: block;
  transform-origin: center center;
  /* When zoomed in, the image becomes bigger than the canvas — let the
     wrapper scroll. align-items/justify-content keep small images centered. */
}

.pv-pdf {
  flex: 1;
  width: 100%;
  height: 100%;
  border: none;
  background: #ffffff;
}

.pv-empty {
  color: #888;
  font-size: 12px;
}
</style>
