import { describe, it, expect, vi, afterEach } from "vitest";
import { VideoElementPool, waitForCurrentFrame } from "../VideoElementPool";

/** Minimal stand-in for an HTMLVideoElement: a real EventTarget with the fields the pool touches. */
class FakeVideo extends EventTarget {
  readyState = 0;
  currentTime = 0;
  paused = true;
  crossOrigin = "";
  preload = "";
  muted = false;
  private _src = "";
  /** What happens after `src` is set: metadata first, a decoded frame later (like a real file). */
  constructor(private readonly dataDelayMs: number) {
    super();
  }
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    if (!v) return;
    setTimeout(() => {
      this.readyState = 1; // HAVE_METADATA: duration known, no frame yet
      this.dispatchEvent(new Event("loadedmetadata"));
    }, 1);
    setTimeout(() => {
      this.readyState = 2; // HAVE_CURRENT_DATA
      this.dispatchEvent(new Event("loadeddata"));
    }, this.dataDelayMs);
  }
  pause() {}
  load() {}
}

describe("export video pool: first frame", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for a decoded frame when no seek is needed (time 0 on a fresh element)", async () => {
    const fake = new FakeVideo(40);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "video" ? fake : Document.prototype.createElement.call(document, tag))) as typeof document.createElement);

    const pool = new VideoElementPool({ maxConcurrent: 2 });
    // currentTime is already 0, so the pool issues no seek. Before the fix this threw
    // "Video not ready after seek" and the export rendered the first frame without the video.
    const video = await pool.acquire("asset://clip.mp4", 0);

    expect(video).toBe(fake as unknown as HTMLVideoElement);
    expect(fake.readyState).toBeGreaterThanOrEqual(2);
    pool.clear();
  });

  it("returns immediately when a frame is already available", async () => {
    const v = new FakeVideo(0);
    v.readyState = 4;
    await expect(waitForCurrentFrame(v as unknown as HTMLVideoElement, "x", 0)).resolves.toBeUndefined();
  });

  it("rejects with a clear message if no frame ever arrives", async () => {
    const v = new FakeVideo(10_000);
    await expect(waitForCurrentFrame(v as unknown as HTMLVideoElement, "clip.mp4", 0, 30)).rejects.toThrow(/no frame decoded.*clip\.mp4/);
  });

  it("rejects when the element errors while waiting", async () => {
    const v = new FakeVideo(10_000);
    const pending = waitForCurrentFrame(v as unknown as HTMLVideoElement, "clip.mp4", 1.5, 1000);
    v.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow(/error while waiting/);
  });
});
