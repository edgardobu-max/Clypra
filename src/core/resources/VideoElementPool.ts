/**
 * Headless Video Element Pool
 *
 * Manages a pool of headless <video> elements for frame extraction.
 * Used by export pipeline and background rendering.
 *
 * Key features:
 * - Headless (not attached to DOM)
 * - Frame-accurate seeking
 * - Resource lifecycle management
 * - Concurrent video support
 */

export interface VideoElementPoolConfig {
  /** Maximum number of concurrent video elements */
  maxConcurrent?: number;

  /** Enable debug logging */
  debug?: boolean;
}

/** Resolves once `video` has data for its current frame (readyState >= HAVE_CURRENT_DATA). */
export function waitForCurrentFrame(video: HTMLVideoElement, sourceUrl: string, seekTime: number, timeoutMs = 8000): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const events = ["loadeddata", "canplay", "seeked"] as const;
    const cleanup = () => {
      clearTimeout(timer);
      for (const ev of events) video.removeEventListener(ev, onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      if (video.readyState >= 2) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Video error while waiting for a frame: ${sourceUrl} @ ${seekTime}s`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Video not ready (no frame decoded): ${sourceUrl} @ ${seekTime}s`));
    }, timeoutMs);
    for (const ev of events) video.addEventListener(ev, onReady);
    video.addEventListener("error", onError);
  });
}

export class VideoElementPool {
  private elements = new Map<string, HTMLVideoElement>();
  private config: Required<VideoElementPoolConfig>;
  private activeCount = 0;

  constructor(config: VideoElementPoolConfig = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 10,
      debug: config.debug ?? false,
    };
  }

  /**
   * Acquire a video element for a source URL.
   * Creates new element if not in pool.
   *
   * @param sourceUrl - Video source URL
   * @param seekTime - Time to seek to (in seconds)
   * @returns Video element ready at seekTime
   */
  async acquire(sourceUrl: string, seekTime: number): Promise<HTMLVideoElement> {
    let video = this.elements.get(sourceUrl);

    if (!video) {
      // Create new headless video element
      video = document.createElement("video");
      // Must be set before `src` — the asset:// protocol serves cross-origin
      // relative to the app page, and COEP: require-corp (tauri.conf.json)
      // taints the element for WebGL texImage2D reads (LUT/color-grade shader)
      // without this.
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true; // Muted for export (no audio in frame extraction)

      // Set source
      video.src = sourceUrl;

      // Wait for metadata to load
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Video metadata load timeout: ${sourceUrl}`));
        }, 10000);

        video!.addEventListener(
          "loadedmetadata",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );

        video!.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error(`Video load error: ${sourceUrl}`));
          },
          { once: true },
        );
      });

      this.elements.set(sourceUrl, video);
      this.activeCount++;
    }

    // Always hard-seek to the exact requested time. An earlier attempt let
    // the video play forward continuously between frames to avoid reseek
    // overhead, but real-time playback keeps advancing by wall-clock time
    // regardless of how long our per-frame render/encode work takes — since
    // that work exceeds one frame's duration, the video kept drifting ahead
    // of the requested time, and the export played back many times too fast.
    // Frame-accurate seeking is required for correctness; the actual export
    // bottleneck was IPC payload size (raw RGBA vs PNG), not this seek.
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - seekTime) > 0.001) {
      video.currentTime = seekTime;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Video seek timeout: ${sourceUrl} @ ${seekTime}s`));
        }, 5000);

        video!.addEventListener(
          "seeked",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );

        video!.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error(`Video seek error: ${sourceUrl} @ ${seekTime}s`));
          },
          { once: true },
        );
      });
    }

    // A frame must actually be decoded before the caller draws it. A freshly created element
    // already sits at currentTime 0, so a request for time 0 issues no seek and the element can
    // still be at HAVE_METADATA: the old code threw here, the export treated that as "video
    // failed to load" and rendered the first frame WITHOUT the video (black).
    await waitForCurrentFrame(video, sourceUrl, seekTime);

    return video;
  }

  /**
   * Release a video element (pause and clear).
   *
   * @param sourceUrl - Video source URL
   */
  release(sourceUrl: string): void {
    const video = this.elements.get(sourceUrl);
    if (video) {
      video.pause();
      video.src = "";
      video.load(); // Release decoder resources
      this.elements.delete(sourceUrl);
      this.activeCount--;
    }
  }

  /**
   * Release all video elements.
   */
  clear(): void {
    for (const [url] of this.elements) {
      this.release(url);
    }
  }

  /**
   * Get pool statistics.
   */
  getStats() {
    return {
      activeCount: this.activeCount,
      maxConcurrent: this.config.maxConcurrent,
      urls: Array.from(this.elements.keys()),
    };
  }
}
