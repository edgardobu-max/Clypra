import { invoke } from "@tauri-apps/api/core";

/** One export = one folder named after the project (copies are numbered), see export.rs. */
export interface ExportFolder {
  folder: string;
  /** Folder name; the video and its cover use it as their file name. */
  stem: string;
}

const BASE_DIR_KEY = "mediadesk.exportBaseDir";

export function loadExportBaseDir(): string {
  try {
    return localStorage.getItem(BASE_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveExportBaseDir(dir: string): void {
  try {
    localStorage.setItem(BASE_DIR_KEY, dir);
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}

/** The folder the next export would create (nothing is created). */
export const previewExportFolder = (baseDir: string, name: string): Promise<ExportFolder> => invoke<ExportFolder>("preview_export_folder", { baseDir, name });

/** Creates the folder for an export (`Name`, then `Name (copia 1)`, `Name (copia 2)`...). */
export const createExportFolder = (baseDir: string, name: string): Promise<ExportFolder> => invoke<ExportFolder>("create_export_folder", { baseDir, name });

/** Removes the folder if a cancelled/failed export left it empty. */
export const removeEmptyExportFolder = (folder: string): Promise<boolean> => invoke<boolean>("remove_empty_export_folder", { folder }).catch(() => false);

/** `<folder>\<stem>.<ext>`, using the folder's own separator style. */
export function joinExportPath(folder: string, stem: string, ext: string): string {
  const sep = folder.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : "/";
  return `${folder}${sep}${stem}.${ext}`;
}
