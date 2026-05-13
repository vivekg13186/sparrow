// Persistent AI provider configuration.
//
// Stored as a JSON file under `$APPCONFIG/ai-config.json` (resolved by
// Tauri's plugin-fs `BaseDirectory.AppConfig`). On macOS that lands at
// `~/Library/Application Support/<bundle id>/`, on Linux at
// `~/.config/<bundle id>/`, on Windows at
// `%APPDATA%\<bundle id>\`. The directory is private to the user account
// in default OS configurations — strictly better than `localStorage`,
// which Tauri persists on disk inside the WebView's profile and which
// any code running in the WebView can read.
//
// Migration: on first read after upgrade, if no file exists but a legacy
// `localStorage` entry does, we copy the values into the file and remove
// the localStorage key.
//
// Future hardening: move to the OS keychain via tauri-plugin-stronghold
// or a small Rust command that writes with 0600 perms. This module's
// public surface is async, so swapping the backend later is cheap.

import {
  writeTextFile,
  readTextFile,
  mkdir,
  exists,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";

const FILE = "ai-config.json";
const BASE = { baseDir: BaseDirectory.AppConfig };
const LEGACY_KEY = "sparrow.ai.config.v1";

const DEFAULT_CONFIG = {
  provider: "openai", // "openai" | "anthropic"
  apiKey: "",
  openaiModel: "gpt-4o-mini",
  anthropicModel: "claude-3-5-sonnet-latest",
  systemPrompt:
    "You are a helpful AI assistant integrated into a code editor. " +
    "Respond directly and concisely. When the user provides selected text " +
    "alongside an instruction, return only what they asked for — no extra " +
    "explanations unless requested.",
  maxTokens: 2048,
};

// Cache so callers that hit getAiConfig() in a tight loop don't re-read
// the file each time. Invalidated by saveAiConfig().
let cached = null;

async function ensureConfigDir() {
  // mkdir with recursive=true is idempotent; cheap to call.
  try {
    await mkdir("", { ...BASE, recursive: true });
  } catch (_) {
    /* already exists */
  }
}

async function readFileConfig() {
  try {
    const present = await exists(FILE, BASE);
    if (!present) return null;
    const text = await readTextFile(FILE, BASE);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (err) {
    console.warn("[ai-config] read failed:", err);
  }
  return null;
}

async function writeFileConfig(cfg) {
  await ensureConfigDir();
  await writeTextFile(FILE, JSON.stringify(cfg, null, 2), BASE);
}

function readLegacyLocalStorage() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (_) {
    /* corrupt — ignore */
  }
  return null;
}

function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Returns the active AI config merged onto sensible defaults. Caches in
 * memory after the first call.
 */
export async function getAiConfig() {
  if (cached) return { ...cached };

  // 1. Prefer the on-disk file.
  const fileCfg = await readFileConfig();
  if (fileCfg) {
    cached = { ...DEFAULT_CONFIG, ...fileCfg };
    return { ...cached };
  }

  // 2. Migrate from localStorage if that's all we have.
  const legacy = readLegacyLocalStorage();
  if (legacy) {
    const merged = { ...DEFAULT_CONFIG, ...legacy };
    try {
      await writeFileConfig(merged);
      clearLegacyLocalStorage();
    } catch (err) {
      console.warn("[ai-config] migration write failed:", err);
    }
    cached = merged;
    return { ...cached };
  }

  // 3. First-run defaults.
  cached = { ...DEFAULT_CONFIG };
  return { ...cached };
}

/** Persists the config to disk and refreshes the in-memory cache. */
export async function saveAiConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  try {
    await writeFileConfig(merged);
    cached = merged;
  } catch (err) {
    console.warn("[ai-config] save failed:", err);
    throw err;
  }
}

/** Quick "is the user set up to call the AI?" check. */
export async function isAiConfigured() {
  const c = await getAiConfig();
  return !!(c.apiKey && c.apiKey.trim());
}

/** Returns the model string to use for the active provider. Sync. */
export function modelForProvider(cfg) {
  return cfg.provider === "anthropic" ? cfg.anthropicModel : cfg.openaiModel;
}
