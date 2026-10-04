/**
 * Project Store
 *
 * OWNERSHIP: Project persistence orchestration (facade, not domain owner)
 * PERSISTENCE: Persistent (saves to disk via Tauri)
 * MUTABILITY: Orchestrates mutations, doesn't own mutable state
 *
 * Responsibilities:
 * - Load project metadata from disk
 * - Save project metadata to disk
 * - Manage media assets list
 * - Trigger auto-save on changes
 * - Coordinate project lifecycle (create/open/close)
 *
 * Does NOT:
 * - Own live timeline state (timelineStore is source of truth)
 * - Mutate timeline directly (delegates to timelineStore.hydrateFromProject)
 * - Manage runtime resources (ProjectSession handles that)
 *
 * Architecture principle:
 * This is a persistence facade. It reads timelineStore for save,
 * and delegates to timelineStore.hydrateFromProject() for load.
 * It NEVER directly mutates timeline state via setState().
 */

import { create } from "zustand";
import type { Project, MediaAsset } from "@/types";
import { MAX_PROJECT_NAME_LENGTH } from "@/types";
import { toRustProject } from "@/types/serialization";
import { generateId } from "@/lib/id";
import { useSettingsStore } from "./settingsStore";
// import { TIMELINE_PPS_PER_ZOOM, TIMELINE_ZOOM_DEFAULT } from "@/lib/timelineZoom";

interface ProjectStore {
  project: Project | null;
  mediaAssets: MediaAsset[];
  recentProjects: Project[];
  toastMessage: string | null;
  toastVariant: "success" | "error" | "warning";
  setToastMessage: (message: string | null, variant?: "success" | "error" | "warning") => void;
  /** Convenience: show toast with variant and auto-dismiss. */
  showToast: (message: string, variant?: "success" | "error" | "warning", durationMs?: number) => void;
  createProject: (name: string, aspectRatio: string, frameRate: 24 | 30 | 60) => void;
  loadProject: (project: Project, payload?: { tracks?: any[]; clips?: any[]; mediaAssets?: MediaAsset[] }) => Promise<void> | void;
  addMediaAsset: (asset: MediaAsset) => void;
  removeMediaAsset: (assetId: string) => void;
  updateProject: (updates: Partial<Project>) => void;
  setRecentProjects: (projects: Project[]) => void;
  renameProject: (projectId: string, newName: string) => Promise<void>;
  /** Set (or clear with null) the video cover and persist it with the project. */
  setCover: (cover: import("@/types").ProjectCover | null) => void;
  deleteProject: (projectId: string) => Promise<void>;
  closeProject: () => Promise<void> | void;
  scheduleAutoSave: () => void;
}

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

const countGraphemes = (str: string): number => {
  return Array.from(graphemeSegmenter.segment(str)).length;
};

const truncateGraphemes = (str: string, max: number): string => {
  const segments = Array.from(graphemeSegmenter.segment(str));
  return segments
    .slice(0, max)
    .map((s) => s.segment)
    .join("");
};

const sanitizeProjectName = (name: string): string => {
  const trimmed = name.trim();
  if (countGraphemes(trimmed) === 0) return "Untitled Project";
  if (countGraphemes(trimmed) > MAX_PROJECT_NAME_LENGTH) {
    return truncateGraphemes(trimmed, MAX_PROJECT_NAME_LENGTH);
  }
  return trimmed;
};

const getAspectRatioDimensions = (ratio: string): { width: number; height: number } => {
  const map: Record<string, { width: number; height: number }> = {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1080, height: 1080 },
    "4:3": { width: 1440, height: 1080 },
    "21:9": { width: 2520, height: 1080 },
  };
  return map[ratio] || map["16:9"];
};

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DELAY = 500; // ms

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: null,
  mediaAssets: [],
  recentProjects: [],
  toastMessage: null,
  toastVariant: "success" as const,

  setToastMessage: (message, variant) => set({ toastMessage: message, ...(variant ? { toastVariant: variant } : {}) }),

  showToast: (message, variant = "success", durationMs = 3000) => {
    set({ toastMessage: message, toastVariant: variant });
    if (durationMs > 0) {
      setTimeout(() => set({ toastMessage: null }), durationMs);
    }
  },

  createProject: async (name, aspectRatio, frameRate) => {
    const sanitizedName = sanitizeProjectName(name);
    const dims = getAspectRatioDimensions(aspectRatio);
    const project: Project = {
      id: generateId("project"),
      name: sanitizedName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      aspectRatio: aspectRatio as any,
      canvasWidth: dims.width,
      canvasHeight: dims.height,
      frameRate,
      duration: 0,
    };
    set({ project, mediaAssets: [] });

    // Let timelineStore reset its own state
    try {
      const { useTimelineStore } = await import("./timelineStore");
      useTimelineStore.getState().hydrateFromProject({ tracks: [], clips: [] });
    } catch (err) {
      console.error("[CreateProject] Failed to hydrate timeline:", err);
    }

    // Initialize runtime session
    try {
      const { createProjectSession } = await import("@/core/runtime/ProjectSession");
      await createProjectSession(project.id);
    } catch (err) {
      console.error("[CreateProject] Runtime initialization failed:", err);
    }

    get().scheduleAutoSave();
  },

  loadProject: async (project, payload) => {
    // Dispose previous runtime first
    try {
      const { disposeActiveSession } = await import("@/core/runtime/ProjectSession");
      await disposeActiveSession();
    } catch (err) {
      console.error("[LoadProject] Runtime disposal failed:", err);
    }

    // Apply project and mediaAssets (projectStore owns these)
    set({ project, mediaAssets: payload?.mediaAssets ?? [] });

    // Let timelineStore hydrate its own state (respects ownership boundary)
    try {
      const { useTimelineStore } = await import("./timelineStore");
      useTimelineStore.getState().hydrateFromProject({
        tracks: payload?.tracks ?? [],
        clips: payload?.clips ?? [],
      });
    } catch (err) {
      // On error, reset timeline to empty state
      import("./timelineStore").then(({ useTimelineStore }) => useTimelineStore.getState().hydrateFromProject({ tracks: [], clips: [] })).catch((resetErr) => console.error("[LoadProject] Failed to reset timeline:", resetErr));
    }

    // Initialize runtime LAST — stores are now fully populated
    try {
      const { createProjectSession } = await import("@/core/runtime/ProjectSession");
      await createProjectSession(project.id);
    } catch (err) {
      console.error("[LoadProject] Runtime initialization failed:", err);
    }
  },

  addMediaAsset: (asset) => {
    set((state) => {
      // Check if asset with same path already exists
      const existingAsset = state.mediaAssets.find((a) => a.path === asset.path);

      if (existingAsset) {
        return state; // No change
      }

      return {
        mediaAssets: [...state.mediaAssets, asset],
      };
    });
    get().scheduleAutoSave();

    // Trigger background thumbnail pre-extraction for video assets.
    // The Low → Medium → High density cascade is handled entirely in Rust
    // Native decoder handles on-demand extraction via decode_frames_streaming
    // No preloading needed - decoder is fast enough (3-15ms per frame)
  },

  removeMediaAsset: (assetId) => {
    set((state) => ({
      mediaAssets: state.mediaAssets.filter((a) => a.id !== assetId),
    }));
    get().scheduleAutoSave();
  },

  updateProject: (updates) => {
    set((state) => ({
      project: state.project ? { ...state.project, ...updates, updatedAt: Date.now() } : null,
    }));
    get().scheduleAutoSave();
  },

  setRecentProjects: (projects) => {
    set({ recentProjects: projects });
  },

  setCover: (cover) => {
    set((state) => (state.project ? { project: { ...state.project, cover, updatedAt: Date.now() } } : {}));
    get().scheduleAutoSave();
  },

  renameProject: async (projectId, newName) => {
    const sanitizedName = sanitizeProjectName(newName);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("rename_project", { projectId, newName: sanitizedName });

      // Update in recent projects list
      set((state) => ({
        recentProjects: state.recentProjects.map((p) => (p.id === projectId ? { ...p, name: sanitizedName } : p)),
      }));

      // If this project is currently open, update it too
      const currentProject = get().project;
      if (currentProject && currentProject.id === projectId) {
        set((state) => ({
          project: state.project ? { ...state.project, name: sanitizedName } : null,
        }));
      }

      get().showToast("Project renamed");
    } catch (error) {
      get().showToast("Failed to rename project", "error");
      throw error;
    }
  },

  deleteProject: async (projectId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_project", { projectId });

      // Remove from recent projects list
      set((state) => ({
        recentProjects: state.recentProjects.filter((p) => p.id !== projectId),
      }));

      // If the deleted project is currently open, close it
      const currentProject = get().project;
      if (currentProject && currentProject.id === projectId) {
        set({ project: null, mediaAssets: [] });
      }
    } catch (error) {
      get().showToast("Failed to delete project", "error");
      throw error;
    }
  },

  closeProject: async () => {
    // Ensure any pending auto-save completes before closing
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      const state = get();
      const { project, mediaAssets } = state;

      if (project) {
        try {
          const { useTimelineStore } = await import("./timelineStore");
          const { tracks, clips } = useTimelineStore.getState();

          // Convert camelCase to snake_case using centralized serialization
          const rustProject = toRustProject(project, { tracks, clips, mediaAssets });

          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("save_project", {
            projectData: JSON.stringify(rustProject),
          });

          get().showToast("Project saved");
        } catch (error) {
          get().showToast("Failed to save before closing", "error");
        }
      }
    }
    // Dispose runtime after we've saved timeline state to avoid save-read race
    try {
      const { disposeActiveSession } = await import("@/core/runtime/ProjectSession");
      await disposeActiveSession();
    } catch (err) {
      console.error("[CloseProject] Error disposing runtime:", err);
    }

    // Now clear project and media assets
    set({ project: null, mediaAssets: [] });

    // Let timelineStore clear its own state
    import("./timelineStore")
      .then(({ useTimelineStore }) => {
        useTimelineStore.getState().hydrateFromProject({ tracks: [], clips: [] });
      })
      .catch((err) => {
        console.error("[CloseProject] Failed to reset timeline:", err);
      });
  },

  scheduleAutoSave: () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }

    // Respect the auto-save toggle from settings
    if (!useSettingsStore.getState().autoSave) return;

    autoSaveTimer = setTimeout(async () => {
      const state = get();
      const { project, mediaAssets } = state;

      if (!project) return;

      try {
        // Import timeline store to get tracks and clips
        const { useTimelineStore } = await import("./timelineStore");
        const { tracks, clips } = useTimelineStore.getState();

        // Convert camelCase to snake_case using centralized serialization
        const rustProject = toRustProject(project, { tracks, clips, mediaAssets });

        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_project", {
          projectData: JSON.stringify(rustProject),
        });
        get().showToast("Project saved");
      } catch (error) {
        console.error("[AutoSave] Failed to save project:", error);
        // Background operation — log only, don't show error toast
      }
    }, AUTO_SAVE_DELAY);
  },
}));
