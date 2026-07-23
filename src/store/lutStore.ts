import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import { listLutAssets, importLutFile, deleteLutAsset, type LutAsset } from "@/lib/lutLibrary";
import { getLutProcessor } from "@/core/render/lut/webglLutProcessor";

interface LutState {
  luts: LutAsset[];
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  /** Opens a native file picker for .cube files and imports the selection. */
  importFromDialog: () => Promise<LutAsset | null>;
  removeLut: (id: string) => Promise<void>;
}

export const useLutStore = create<LutState>((set, get) => ({
  luts: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const luts = await listLutAssets();
      set({ luts, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFromDialog: async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "3D LUT", extensions: ["cube"] }],
    });
    if (!selected || Array.isArray(selected)) return null;

    set({ loading: true, error: null });
    try {
      const asset = await importLutFile(selected);
      set((state) => ({ luts: [...state.luts, asset].sort((a, b) => a.name.localeCompare(b.name)), loading: false }));
      return asset;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  removeLut: async (id: string) => {
    await deleteLutAsset(id);
    getLutProcessor()?.evictLut(id);
    set((state) => ({ luts: state.luts.filter((l) => l.id !== id) }));
  },
}));

export function getLutAssetById(id: string): LutAsset | undefined {
  return useLutStore.getState().luts.find((l) => l.id === id);
}
