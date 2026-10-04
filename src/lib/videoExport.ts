/**
 * Video Export
 *
 * High-level API for exporting videos using FFmpeg.
 * Integrates with the frame scheduler for frame rendering.
 *
 * Architecture:
 *   Timeline → Frame Scheduler → RGBA Frames → FFmpeg → MP4/MOV
 */

import { invoke, Channel, convertFileSrc } from "@tauri-apps/api/core";
import { getFrameScheduler } from "../core/scheduler/FrameScheduler";
import { VideoElementPool } from "../core/resources/VideoElementPool";
import type { Clip, Track, MediaAsset, Project } from "../types";

/**
 * Export progress callback.
 */
export interface VideoExportProgress {
  /** Current frame number */
  currentFrame: number;

  /** Total frames to export */
  totalFrames: number;

  /** Progress (0.0 - 1.0) */
  progress: number;

  /** Estimated time remaining in seconds */
  etaSeconds: number;

  /** Current FPS (frames per second) */
  fps: number;
}

/**
 * Video export configuration.
 */
export interface VideoExportConfig {
  /** Timeline clips */
  clips: Clip[];

  /** Timeline tracks */
  tracks: Track[];

  /** Media assets */
  assets: MediaAsset[];

  /** Project settings */
  project: Project | null;

  /** Timeline epoch (for cache) */
  epoch: number;

  /** Start time in seconds */
  startTime: number;

  /** End time in seconds */
  endTime: number;

  /** Output file path */
  outputPath: string;

  /** Frame rate (defaults to project frame rate) */
  frameRate?: number;

  /** Output width (defaults to project canvas width) */
  width?: number;

  /** Output height (defaults to project canvas height) */
  height?: number;

  /** Video codec (h264, h265, prores) */
  codec?: "h264" | "h265" | "prores";

  /** Quality preset (ultrafast, fast, medium, slow, veryslow) */
  preset?: "ultrafast" | "fast" | "medium" | "slow" | "veryslow";

  /** CRF quality (0-51, lower = better quality) */
  crf?: number;

  /** Pixel format (yuv420p, yuv444p, yuv422p10le) */
  pixelFormat?: "yuv420p" | "yuv444p" | "yuv422p10le";

  /** Progress callback */
  onProgress?: (progress: VideoExportProgress) => void;

  /** Polled each frame; return true to abort the export in progress. */
  shouldCancel?: () => boolean;
}

/**
 * Video export result.
 */
export interface VideoExportResult {
  /** Output file path */
  outputPath: string;

  /** Total frames exported */
  totalFrames: number;

  /** Total time in ms */
  totalTimeMs: number;

  /** Average time per frame in ms */
  avgTimePerFrameMs: number;

  /** Whether export was cancelled */
  cancelled: boolean;
}

/**
 * Export a video.
 *
 * This uses the frame scheduler to render frames and pipes them to FFmpeg.
 *
 * @param config - Export configuration
 * @returns Export result
 */
export async function exportVideo(config: VideoExportConfig): Promise<VideoExportResult> {
  const { clips, tracks, assets, project, epoch, startTime, endTime, outputPath, frameRate = project?.frameRate || 30, width = project?.canvasWidth || 1920, height = project?.canvasHeight || 1080, codec = "h264", preset = "medium", crf = 23, pixelFormat = "yuv420p", onProgress, shouldCancel } = config;

  const startTimeMs = Date.now();

  // Calculate frame times
  const frameDuration = 1 / frameRate;
  const frameTimes: number[] = [];
  for (let time = startTime; time < endTime; time += frameDuration) {
    frameTimes.push(time);
  }

  const totalFrames = frameTimes.length;

  if (totalFrames === 0) {
    throw new Error("No frames to export");
  }

  // Get scheduler and update timeline state
  const scheduler = getFrameScheduler();
  scheduler.updateTimeline(clips, tracks, assets, project, epoch);

  // Create headless video element pool for export
  const videoPool = new VideoElementPool({
    maxConcurrent: 10,
    debug: false,
  });

  // Start FFmpeg export session
  const sessionId = await invoke<string>("start_video_export", {
    config: {
      outputPath,
      width,
      height,
      frameRate,
      totalFrames,
      codec,
      preset,
      crf,
      pixelFormat,
    },
  });

  let cancelled = false;
  let completedFrames = 0;

  try {
    // Render and write frames
    for (let i = 0; i < frameTimes.length; i++) {
      if (shouldCancel?.()) {
        throw new Error("Export cancelled by user");
      }

      const time = frameTimes[i];

      // Pre-load and seek all video elements for this frame
      const videoElements = new Map<string, HTMLVideoElement>();

      // Find all video clips active at this time
      for (const clip of clips) {
        const asset = assets.find((a) => a.id === clip.mediaId);
        if (asset?.type !== "video") continue;

        // Check if clip is active at this time
        const clipEnd = clip.startTime + clip.duration;
        if (time < clip.startTime || time >= clipEnd) continue;

        // Calculate source time (accounting for trim)
        const clipLocalTime = time - clip.startTime;
        const trimIn = clip.trimIn || 0;
        const sourceTime = trimIn + clipLocalTime;

        // Acquire video element at exact frame time. asset.path is a raw
        // filesystem path — convertFileSrc maps it to the asset:// URL the
        // webview can actually load (matches PreviewMediaPool's handling).
        const key = `${clip.id}-${clip.mediaId}`;
        const sourceUrl = asset.path.startsWith("asset://") ? asset.path : convertFileSrc(asset.path);
        try {
          const video = await videoPool.acquire(sourceUrl, sourceTime);
          videoElements.set(key, video);
        } catch (error) {
          console.warn(`Failed to acquire video for ${key}:`, error);
          // Continue without this video - rasterizer will use fallback
        }
      }

      // Schedule frame render with video elements. Requesting a PNG blob
      // (rather than raw ImageData) keeps the per-frame IPC payload small —
      // Tauri's invoke() JSON-encodes arguments regardless of typed-array vs
      // plain array, so an ~8MB raw RGBA frame was the actual export
      // bottleneck (~0.2 fps); PNG cuts that by roughly 15-20x.
      const jobId = scheduler.schedule({
        time,
        resolution: { width, height },
        pixelRatio: 1,
        outputFormat: "blob",
        priority: "export",
        videoElements,
      });

      // Wait for frame
      const result = await scheduler.wait(jobId);

      if (!(result.data instanceof Blob)) {
        throw new Error("Expected Blob output from scheduler");
      }

      const frameBuffer = await result.data.arrayBuffer();

      // Create progress channel
      const progressChannel = new Channel<VideoExportProgress>();
      progressChannel.onmessage = (progress) => {
        if (onProgress) {
          onProgress(progress);
        }
      };

      // Write frame (PNG bytes) to FFmpeg, which decodes them via image2pipe.
      await invoke("write_export_frame", {
        sessionId,
        frameData: frameBuffer,
        onProgress: progressChannel,
      });

      completedFrames++;
    }

    // Finalize export
    await invoke("finalize_video_export", { sessionId });
  } catch (error) {
    // Check if cancelled
    if (error instanceof Error && error.message.includes("cancelled")) {
      cancelled = true;
      await invoke("cancel_video_export", { sessionId }).catch(() => {
        // Ignore errors during cancellation
      });
    } else {
      // Try to cancel on error
      await invoke("cancel_video_export", { sessionId }).catch(() => {
        // Ignore errors during cancellation
      });
      throw error;
    }
  } finally {
    // Always clean up video pool
    videoPool.clear();
  }

  const totalTimeMs = Date.now() - startTimeMs;
  const avgTimePerFrameMs = completedFrames > 0 ? totalTimeMs / completedFrames : 0;

  return {
    outputPath,
    totalFrames: completedFrames,
    totalTimeMs,
    avgTimePerFrameMs,
    cancelled,
  };
}

/**
 * Check if FFmpeg is available on the system.
 *
 * @returns True if FFmpeg is available
 */
export async function checkFFmpegAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("check_ffmpeg_available");
  } catch {
    return false;
  }
}

/**
 * Get FFmpeg version information.
 *
 * @returns FFmpeg version string
 */
export async function getFFmpegVersion(): Promise<string> {
  return await invoke<string>("get_ffmpeg_version");
}

/**
 * Get recommended export presets.
 */
export function getExportPresets() {
  return {
    "1080p-fast": {
      width: 1920,
      height: 1080,
      codec: "h264" as const,
      preset: "fast" as const,
      crf: 23,
      pixelFormat: "yuv420p" as const,
    },
    "1080p-quality": {
      width: 1920,
      height: 1080,
      codec: "h264" as const,
      preset: "slow" as const,
      crf: 18,
      pixelFormat: "yuv420p" as const,
    },
    "720p-fast": {
      width: 1280,
      height: 720,
      codec: "h264" as const,
      preset: "fast" as const,
      crf: 23,
      pixelFormat: "yuv420p" as const,
    },
    "4k-quality": {
      width: 3840,
      height: 2160,
      codec: "h265" as const,
      preset: "medium" as const,
      crf: 20,
      pixelFormat: "yuv420p" as const,
    },
    "prores-422hq": {
      width: 1920,
      height: 1080,
      codec: "prores" as const,
      preset: "medium" as const,
      crf: 0,
      pixelFormat: "yuv422p10le" as const,
    },
  };
}
