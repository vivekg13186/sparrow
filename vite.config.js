import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue()],

  // The spell-check worker uses dynamic `import()` calls to lazy-load
  // cspell-trie-lib + the English word list. Vite's default worker
  // output is IIFE, which can't do code-splitting (and therefore can't
  // handle dynamic imports), so the build fails with:
  //   Invalid value "iife" for option "worker.format" — UMD and IIFE
  //   output formats are not supported for code-splitting builds.
  // ES-module workers are supported in every WebView Tauri 2 targets
  // (WebKit2GTK on Linux, WebKit on macOS, WebView2 on Windows), so
  // we just flip the format.
  worker: {
    format: "es",
  },

  resolve: {
    // cspell-trie-lib (and similar deps) imports Node's built-in `os`
    // module to call `os.endianness()`. Vite's default browser target
    // externalizes Node built-ins, which leaves the export undefined
    // and the build fails:
    //   "endianness" is not exported by "__vite-browser-external"
    //
    // The shim is a tiny ESM module that re-exports the handful of
    // functions deps actually reach for. See src/shims/os-shim.js for
    // the rationale.
    alias: {
      os: path.resolve(__dirname, "src/shims/os-shim.js"),
      "node:os": path.resolve(__dirname, "src/shims/os-shim.js"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
