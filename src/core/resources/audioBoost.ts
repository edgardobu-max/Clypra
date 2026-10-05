/**
 * Preview-side volume boost above 100 %.
 *
 * HTMLMediaElement.volume tops out at 1, so a clip set to 150 % or 300 % could not be heard
 * louder in the preview even though the export (FFmpeg `volume`) applied it. Elements that need
 * more than unity gain are routed through the Web Audio API:
 *
 *   element -> MediaElementSource -> GainNode -> limiter (shared) -> speakers
 *
 * Once an element has been routed this way it stays on the graph (createMediaElementSource can
 * only be called once per element), and all its gain, quiet or loud, goes through the GainNode.
 * Elements that never exceed 100 % are left alone and keep using `element.volume`.
 *
 * The shared compressor acts as a soft limiter so boosted peaks are squashed instead of
 * hard-clipping the speakers (the export has its own limiter).
 */

interface Chain {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export class AudioBoost {
  private ctx: AudioContext | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private readonly chains = new WeakMap<HTMLMediaElement, Chain>();

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -2;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;
      this.limiter.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.limiter = null;
    }
    return this.ctx;
  }

  /**
   * Sets the element's total gain (master x clip x fades; may exceed 1).
   * @returns true when the Web Audio chain handled it, false when the caller should use `element.volume`.
   */
  apply(element: HTMLMediaElement, totalGain: number): boolean {
    const gain = Math.max(0, totalGain);
    let chain = this.chains.get(element);

    if (!chain) {
      if (gain <= 1) return false;
      const ctx = this.context();
      if (!ctx || !this.limiter) return false;
      try {
        const source = ctx.createMediaElementSource(element);
        const node = ctx.createGain();
        source.connect(node);
        node.connect(this.limiter);
        chain = { source, gain: node };
        this.chains.set(element, chain);
      } catch {
        return false;
      }
    }

    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    element.volume = 1; // the GainNode now owns the level
    chain.gain.gain.value = gain;
    return true;
  }

  /** Releases an element's nodes when it is disposed. */
  forget(element: HTMLMediaElement): void {
    const chain = this.chains.get(element);
    if (!chain) return;
    try {
      chain.source.disconnect();
      chain.gain.disconnect();
    } catch {
      // already disconnected
    }
    this.chains.delete(element);
  }
}
