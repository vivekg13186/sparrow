<script setup>
// A single xterm.js terminal tab backed by a PTY in the Tauri Rust process.
//
// Lifecycle:
//   onMounted   → create xterm + FitAddon, call `terminal_spawn`, subscribe
//                 to the per-session data/exit events, wire input + resize.
//   onUnmount   → unsubscribe, call `terminal_kill`, dispose xterm.
//
// The parent toggles visibility via the `active` prop (we use v-show in the
// parent so the terminal isn't torn down when the user switches tabs).
// Whenever `active` flips on, we re-fit and re-focus.

import { ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const props = defineProps({
  active: { type: Boolean, default: false },
  // Optional command string written to the PTY once the shell is up. Used by
  // the Quick Actions feature to launch a tab and immediately run a command.
  initialCommand: { type: String, default: "" },
});
const emit = defineEmits(["exit", "ready"]);

const container = ref(null);

// Held in closure (not reactive) — Vue shouldn't observe Monaco/xterm objects.
let term = null;
let fitAddon = null;
let sessionId = null;
let unlistenData = null;
let unlistenExit = null;
let resizeObserver = null;
let inputDisposable = null;
let resizeDisposable = null;
let disposed = false;

async function spawn() {
  term = new Terminal({
    fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
    fontSize: 13,
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
    },
    cursorBlink: true,
    convertEol: true,
    allowProposedApi: true,
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container.value);

  // Give the DOM a tick so FitAddon can measure correctly.
  await nextTick();
  try {
    fitAddon.fit();
  } catch (_) {
    // Container has zero size — happens if tab is hidden at mount.
  }
  const cols = term.cols || 80;
  const rows = term.rows || 24;

  try {
    sessionId = await invoke("terminal_spawn", { rows, cols });
  } catch (err) {
    term.write(`\r\n\x1b[31mFailed to spawn terminal: ${err}\x1b[0m\r\n`);
    return;
  }

  if (disposed) {
    // Component was unmounted while spawn was in flight.
    invoke("terminal_kill", { sessionId }).catch(() => {});
    return;
  }

  // PTY → xterm.
  unlistenData = await listen(`terminal://${sessionId}/data`, (event) => {
    // payload is Vec<u8> serialized as a JS array of numbers.
    const payload = event.payload;
    const bytes =
      payload instanceof Uint8Array
        ? payload
        : new Uint8Array(payload);
    term.write(bytes);
  });
  unlistenExit = await listen(`terminal://${sessionId}/exit`, () => {
    term.write("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
    emit("exit");
  });

  // xterm → PTY.
  inputDisposable = term.onData((data) => {
    if (!sessionId) return;
    invoke("terminal_write", { sessionId, data }).catch((e) =>
      console.error("terminal_write failed:", e)
    );
  });

  // Forward resize requests (initiated by FitAddon below).
  resizeDisposable = term.onResize(({ cols, rows }) => {
    if (!sessionId) return;
    invoke("terminal_resize", { sessionId, rows, cols }).catch(() => {});
  });

  // Auto-fit as the container resizes (window resize, sidebar toggle, etc.).
  resizeObserver = new ResizeObserver(() => {
    if (!props.active || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch (_) {
      /* ignore */
    }
  });
  resizeObserver.observe(container.value);

  if (props.active) term.focus();
  emit("ready");

  // If the caller asked for an initial command (Quick Actions), write it
  // shortly after the shell's prompt has had a chance to render. The PTY
  // buffers either way, but a small delay makes the command appear *after*
  // the prompt instead of jumping in front of it.
  if (props.initialCommand) {
    const cmd = props.initialCommand;
    setTimeout(() => {
      if (disposed || !sessionId) return;
      invoke("terminal_write", { sessionId, data: cmd + "\r" }).catch((e) =>
        console.error("[terminal] initial command failed:", e)
      );
    }, 180);
  }
}

onMounted(() => {
  spawn();
});

onBeforeUnmount(() => {
  disposed = true;
  if (unlistenData) unlistenData();
  if (unlistenExit) unlistenExit();
  if (resizeObserver) resizeObserver.disconnect();
  if (inputDisposable) inputDisposable.dispose();
  if (resizeDisposable) resizeDisposable.dispose();
  if (sessionId) {
    invoke("terminal_kill", { sessionId }).catch(() => {});
  }
  if (term) term.dispose();
});

// When this tab becomes active, re-fit (the container may have grown while
// hidden) and refocus.
watch(
  () => props.active,
  async (isActive) => {
    if (!isActive) return;
    await nextTick();
    if (fitAddon) {
      try {
        fitAddon.fit();
      } catch (_) {
        /* ignore */
      }
    }
    if (term) term.focus();
  }
);
</script>

<template>
  <div ref="container" class="terminal-host"></div>
</template>

<style scoped>
.terminal-host {
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  padding: 4px 6px;
  box-sizing: border-box;
}
</style>
