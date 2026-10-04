/**
 * Test setup file for Vitest
 * Configures testing environment and global utilities
 */

import { expect, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// jsdom renders canvases through the native `canvas` package, which is loaded on the FIRST
// getContext() call and takes >1 s (several times that on a loaded machine). Without this
// warm-up that cost lands inside whichever test mounts the first canvas (e.g. a clip with a
// filmstrip) and blows the 5 s test timeout. Pay it here, outside any test — but only for
// component tests, the ones that mount canvases (the other files never touch a canvas).
const testPath = (expect.getState().testPath ?? "").split(String.fromCharCode(92)).join("/");
if (typeof document !== "undefined" && testPath.includes("/components/")) {
  try {
    document.createElement("canvas").getContext("2d");
  } catch {
    // no canvas backend available: tests that need one mock getContext themselves
  }
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock AudioContext for tests
class MockAudioContext {
  currentTime = 0;
  destination = {};
  state = "running";

  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
  }

  decodeAudioData() {
    return Promise.resolve({
      duration: 1,
      length: 44100,
      numberOfChannels: 2,
      sampleRate: 44100,
    });
  }

  close() {
    return Promise.resolve();
  }

  resume() {
    return Promise.resolve();
  }

  suspend() {
    return Promise.resolve();
  }
}

// @ts-expect-error - Mocking global AudioContext
global.AudioContext = MockAudioContext;
