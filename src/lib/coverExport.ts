/**
 * Saves the project's cover next to an exported video as `<video name>_cover.png`.
 *
 * - Frame cover: the timeline composited at that time, at the project's size.
 * - Local image cover: the chosen image re-encoded as PNG (so the output name/format is
 *   always the same whatever the source was: jpg, webp, png).
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { renderFrameBlob } from "./frameRender";
import type { Clip, Track, MediaAsset, Project } from "../types";

/** `D:\Videos\clip.mp4` -> `D:\Videos\clip_cover.png` (keeps the folder and the slash style). */
export function coverPathForVideo(videoPath: string): string {
  const lastSep = Math.max(videoPath.lastIndexOf("/"), videoPath.lastIndexOf(String.fromCharCode(92)));
  const lastDot = videoPath.lastIndexOf(".");
  const base = lastDot > lastSep ? videoPath.slice(0, lastDot) : videoPath;
  return `${base}_cover.png`;
}

/** Writes bytes to disk through the binary save_image_file command. */
export async function saveImageBytes(path: string, blob: Blob): Promise<void> {
  await invoke("save_image_file", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(path) } });
}

/** Decodes an image file from disk and re-encodes it as PNG. */
export async function localImageToPngBlob(path: string): Promise<Blob> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Could not read the cover image (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas available to convert the cover image");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/** Source rectangle for drawing an image into a box with "cover" fit (fill, centre-crop the overflow). */
export function coverFitRect(srcW: number, srcH: number, dstW: number, dstH: number): { sx: number; sy: number; sw: number; sh: number } {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

/** A local image drawn at exactly `width` x `height` (cover fit), as PNG: the video's first frame. */
export async function localImageToFrameBlob(path: string, width: number, height: number): Promise<Blob> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Could not read the cover image (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas available to prepare the cover frame");
  const { sx, sy, sw, sh } = coverFitRect(bitmap.width, bitmap.height, width, height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  return canvas.convertToBlob({ type: "image/png" });
}

export interface CoverFrameOptions extends Omit<ExportCoverOptions, "videoPath"> {
  /** Size of the video being exported. */
  width: number;
  height: number;
}

/**
 * The project's cover as a video-sized PNG, to be written as the FIRST frame of the export so
 * platforms that take frame 0 as the thumbnail pick it up. Null when the project has no cover.
 */
export async function buildCoverFrameBlob({ project, clips, tracks, assets, epoch, sequenceDuration, width, height }: CoverFrameOptions): Promise<Blob | null> {
  const cover = project.cover;
  if (!cover) return null;
  if (cover.kind === "image") return localImageToFrameBlob(cover.path, width, height);
  const time = Math.min(cover.time, Math.max(0, sequenceDuration - 0.001));
  return renderFrameBlob({ clips, tracks, assets, project, epoch, time, width, height });
}

export interface ExportCoverOptions {
  videoPath: string;
  project: Project;
  clips: Clip[];
  tracks: Track[];
  assets: MediaAsset[];
  epoch: number;
  /** Timeline length in seconds (a frame cover is clamped inside it). */
  sequenceDuration: number;
}

/**
 * @returns the cover's path, or null when the project has no cover.
 * @throws when the cover is set but could not be produced or written.
 */
export async function exportCoverNextToVideo({ videoPath, project, clips, tracks, assets, epoch, sequenceDuration }: ExportCoverOptions): Promise<string | null> {
  const cover = project.cover;
  if (!cover) return null;

  const coverPath = coverPathForVideo(videoPath);
  let blob: Blob;
  if (cover.kind === "image") {
    blob = await localImageToPngBlob(cover.path);
  } else {
    const time = Math.min(cover.time, Math.max(0, sequenceDuration - 0.001));
    blob = await renderFrameBlob({ clips, tracks, assets, project, epoch, time, width: project.canvasWidth, height: project.canvasHeight });
  }
  await saveImageBytes(coverPath, blob);
  return coverPath;
}
