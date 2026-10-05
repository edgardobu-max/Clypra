import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioBoost } from "../audioBoost";

/** Records what the boost builds so we can assert on the Web Audio graph without a real browser. */
function installFakeAudioContext() {
  const gainNodes: { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const created = { sources: 0, contexts: 0 };
  class FakeContext {
    state = "running";
    destination = {};
    constructor() {
      created.contexts++;
    }
    createDynamicsCompressor() {
      return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: vi.fn() };
    }
    createMediaElementSource(el: unknown) {
      created.sources++;
      return { el, connect: vi.fn(), disconnect: vi.fn() };
    }
    createGain() {
      const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      gainNodes.push(node);
      return node;
    }
    resume() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  return { gainNodes, created };
}

const element = () => ({ volume: 0.3 }) as unknown as HTMLMediaElement;

describe("AudioBoost (preview gain above 100 %)", () => {
  let fake: ReturnType<typeof installFakeAudioContext>;
  beforeEach(() => {
    fake = installFakeAudioContext();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves elements at or below unity alone (the caller uses element.volume)", () => {
    const boost = new AudioBoost();
    const el = element();
    expect(boost.apply(el, 0.6)).toBe(false);
    expect(boost.apply(el, 1)).toBe(false);
    expect(fake.created.contexts).toBe(0); // no AudioContext until something is actually boosted
    expect(el.volume).toBe(0.3); // untouched
  });

  it("routes an element through a GainNode when the gain exceeds 1", () => {
    const boost = new AudioBoost();
    const el = element();
    expect(boost.apply(el, 2.5)).toBe(true);
    expect(fake.created.sources).toBe(1);
    expect(fake.gainNodes[0].gain.value).toBe(2.5);
    expect(el.volume).toBe(1); // the GainNode owns the level now
  });

  it("keeps handling the element afterwards, including gains below 1, without re-creating the chain", () => {
    const boost = new AudioBoost();
    const el = element();
    boost.apply(el, 3);
    expect(boost.apply(el, 0.5)).toBe(true);
    expect(fake.gainNodes[0].gain.value).toBe(0.5);
    expect(boost.apply(el, 0)).toBe(true);
    expect(fake.gainNodes[0].gain.value).toBe(0);
    expect(fake.created.sources).toBe(1); // createMediaElementSource may only be called once per element
  });

  it("shares one AudioContext across elements and forget() disconnects the chain", () => {
    const boost = new AudioBoost();
    const a = element();
    const b = element();
    boost.apply(a, 2);
    boost.apply(b, 2);
    expect(fake.created.contexts).toBe(1);
    boost.forget(a);
    expect(fake.gainNodes[0].disconnect).toHaveBeenCalled();
    // after forgetting, a quiet gain no longer needs the graph
    expect(boost.apply(a, 0.5)).toBe(false);
  });

  it("falls back to element.volume when Web Audio is unavailable", () => {
    vi.unstubAllGlobals();
    (window as unknown as { AudioContext?: unknown }).AudioContext = undefined;
    const boost = new AudioBoost();
    expect(boost.apply(element(), 3)).toBe(false);
  });
});
