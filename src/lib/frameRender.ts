/**
 * Render a single timeline frame (every visible track composited, titles and brand
 * elements included) to an image. Used by the cover picker and the cover export.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { getFrameScheduler } from "../core/scheduler/FrameScheduler";
import { VideoElementPool } from "../core/resources/VideoElementPool";
import type { Clip, Track, MediaAsset, Project } from "../types";

export interface RenderFrameOptions {
  clips: Clip[];
  tracks: Track[];
  assets: MediaAsset[];
  project: Project | null;
  epoch: number;
  /** Timeline time in seconds. */
  time: number;
  width: number;
  height: number;
}

/** Renders the composite at `time` as a PNG blob. */
export async function renderFrameBlob({ clips, tracks, assets, project, epoch, time, width, height }: RenderFrameOptions): Promise<Blob> {
  const scheduler = getFrameScheduler();
  scheduler.updateTimeline(clips, tracks, assets, project, epoch);

  const pool = new VideoElementPool({ maxConcurrent: 10, debug: false });
  try {
    const videoElements = new Map<string, HTMLVideoElement>();
    for (const clip of clips) {
      const asset = assets.find((a) => a.id === clip.mediaId);
      if (asset?.type !== "video") continue;
      if (time < clip.startTime || time >= clip.startTime + clip.duration) continue;

      const sourceTime = (clip.trimIn || 0) + (time - clip.startTime);
      const url = asset.path.startsWith("asset://") ? asset.path : convertFileSrc(asset.path);
      try {
        videoElements.set(`${clip.id}-${clip.mediaId}`, await pool.acquire(url, sourceTime));
      } catch (error) {
        console.warn(`[frameRender] could not load ${asset.path}:`, error);
      }
    }

    const jobId = scheduler.schedule({ time, resolution: { width, height }, pixelRatio: 1, outputFormat: "blob", priority: "export", videoElements });
    const result = await scheduler.wait(jobId);
    if (!(result.data instanceof Blob)) throw new Error("Frame renderer did not return an image");
    return result.data;
  } finally {
    pool.clear();
  }
}

/** Re-encodes a PNG blob as JPEG (opaque background) when the user picks a .jpg name. */
export async function pngToJpegBlob(png: Blob, quality = 0.95): Promise<Blob> {
  const bitmap = await createImageBitmap(png);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context for JPEG export");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed"))), "image/jpeg", quality));
}
