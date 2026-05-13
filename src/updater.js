// Thin wrapper around tauri-plugin-updater + tauri-plugin-process.
//
// The plugin hits the URLs listed in `tauri.conf.json → plugins.updater
// .endpoints`, verifies the downloaded archive against the configured
// public key, and applies it. We expose two helpers:
//
//   checkForUpdate()         – returns the Update object (with .version,
//                              .body, .currentVersion) if a newer signed
//                              build is available, or null when up to date.
//
//   installAndRelaunch(u, p) – runs downloadAndInstall on the update,
//                              calling `p({ downloaded, total })` as
//                              bytes stream in, then relaunches the app.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForUpdate() {
  return await check();
}

export async function installAndRelaunch(update, onProgress) {
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data?.contentLength || 0;
      if (onProgress) onProgress({ downloaded: 0, total });
    } else if (event.event === "Progress") {
      downloaded += event.data?.chunkLength || 0;
      if (onProgress) onProgress({ downloaded, total });
    } else if (event.event === "Finished") {
      if (onProgress) onProgress({ downloaded: total || downloaded, total });
    }
  });
  await relaunch();
}
