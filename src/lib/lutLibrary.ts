/**
 * LUT Library
 *
 * Talks to the Rust-side LUT store (app_data_dir/luts/) and caches parsed
 * .cube data in memory so repeated frames/clips don't re-read + re-parse the
 * file every time.
 */

import { invoke } from "@tauri-apps/api/core";
import { parseCubeLut, type ParsedCubeLut } from "@/core/render/lut/cubeParser";

export interface LutAsset {
  id: string;
  name: string;
  path: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function importLutFile(sourcePath: string): Promise<LutAsset> {
  if (!isTauri) throw new Error("LUT import requires the desktop app");
  return invoke<LutAsset>("import_lut_file", { sourcePath });
}

export async function listLutAssets(): Promise<LutAsset[]> {
  if (!isTauri) return [];
  return invoke<LutAsset[]>("list_lut_assets");
}

export async function deleteLutAsset(id: string): Promise<void> {
  if (!isTauri) return;
  _parsedCache.delete(id);
  await invoke("delete_lut_asset", { id });
}

// ─── Parsed .cube cache ─────────────────────────────────────────────────────

const _parsedCache = new Map<string, Promise<ParsedCubeLut>>();

/** Load and parse a LUT's .cube file, cached by lutId for the session. */
export function loadParsedLut(asset: LutAsset): Promise<ParsedCubeLut> {
  let pending = _parsedCache.get(asset.id);
  if (!pending) {
    pending = invoke<string>("read_lut_cube", { path: asset.path }).then(parseCubeLut);
    _parsedCache.set(asset.id, pending);
    // Don't cache a rejected parse — let the next attempt retry.
    pending.catch(() => _parsedCache.delete(asset.id));
  }
  return pending;
}
