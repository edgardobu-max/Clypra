import { describe, it, expect, vi, beforeEach } from "vitest";

// Simulate "no network / no upstream API key": every call to the upstream API rejects.
vi.mock("@/features/text-effects/api/clypraApi", () => ({
  ClypraApi: {
    getTemplatesIndex: vi.fn().mockRejectedValue(new Error("network down")),
    getTemplate: vi.fn().mockRejectedValue(new Error("network down")),
    checkApiHealth: vi.fn().mockResolvedValue(false),
  },
}));

import { useTemplateStore } from "../templateStore";
import { ALL_TEMPLATES } from "../templates/index";

describe("text templates without the upstream API (offline)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useTemplateStore.setState({ templates: [], isApiConnected: true, isLoading: false });
  });

  // NOTE: the bundled static set (`ALL_TEMPLATES`) is currently EMPTY, so offline the Templates
  // tab has nothing to show (the UI says so and points to the built-in Titles tab). If static
  // templates are ever bundled, this fallback starts serving them with no code change.
  it("falls back to the static templates and reports the API as not connected", async () => {
    await useTemplateStore.getState().loadTemplates();
    const state = useTemplateStore.getState();
    expect(state.isApiConnected).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.templates).toEqual(ALL_TEMPLATES);
  });
});
