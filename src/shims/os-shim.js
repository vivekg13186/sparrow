// Minimal browser shim for Node's built-in `os` module.
//
// Why this exists:
//   `cspell-trie-lib` (and a handful of similar trie / compression
//   libraries) call `os.endianness()` at runtime to pick between
//   little-endian and big-endian on-disk formats. Vite's default
//   browser target treats `os` as `__vite-browser-external`, which
//   has no exports, so the bundle fails at build time with:
//
//     "endianness" is not exported by "__vite-browser-external"
//
//   This file is aliased in vite.config.js so every `import "os"` /
//   `import "node:os"` resolves to this module instead.
//
// Coverage:
//   Only the functions our deps actually reach for at runtime are
//   meaningfully implemented. Everything else returns harmless
//   defaults so we don't crash if some other library introspects.
//
// Endianness:
//   Every platform Sparrow targets (macOS x86_64 + ARM64, Windows
//   x86_64, Linux x86_64 + ARM64) is little-endian. If a big-endian
//   target ever shows up, plumb feature detection through here:
//
//     const u16 = new Uint16Array([0xff00]);
//     const isLE = new Uint8Array(u16.buffer)[0] === 0x00;
//     return isLE ? "LE" : "BE";

export function endianness() {
  return "LE";
}

export function platform() {
  return "browser";
}

export function arch() {
  return "unknown";
}

export function release() {
  return "";
}

export function type() {
  return "Browser";
}

export function tmpdir() {
  return "/tmp";
}

export function homedir() {
  return "/";
}

export function hostname() {
  return "localhost";
}

export function cpus() {
  return [];
}

export function freemem() {
  return 0;
}

export function totalmem() {
  return 0;
}

export function uptime() {
  return 0;
}

export const EOL = "\n";

// Default export so `import os from "os"` works the same way as
// `import { endianness } from "os"`.
export default {
  endianness,
  platform,
  arch,
  release,
  type,
  tmpdir,
  homedir,
  hostname,
  cpus,
  freemem,
  totalmem,
  uptime,
  EOL,
};
