import { describe, it, expect } from "vitest";
import { applyClick, selectAll, pruneSelection, targetIds, EMPTY_SELECTION } from "../mediaSelection";

const order = ["a", "b", "c", "d", "e"];
const plain = { shift: false, toggle: false };

describe("applyClick", () => {
  it("a plain click selects only that item and sets the anchor", () => {
    const s = applyClick({ ids: ["a", "b"], anchor: "a" }, "c", order, plain);
    expect(s).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("Ctrl+click toggles items on and off", () => {
    let s = applyClick(EMPTY_SELECTION, "b", order, { shift: false, toggle: true });
    s = applyClick(s, "d", order, { shift: false, toggle: true });
    expect(s.ids).toEqual(["b", "d"]);
    s = applyClick(s, "b", order, { shift: false, toggle: true });
    expect(s.ids).toEqual(["d"]);
  });

  it("Shift+click selects the range from the anchor, in either direction", () => {
    const base = { ids: ["b"], anchor: "b" };
    expect(applyClick(base, "d", order, { shift: true, toggle: false }).ids).toEqual(["b", "c", "d"]);
    expect(applyClick({ ids: ["d"], anchor: "d" }, "a", order, { shift: true, toggle: false }).ids).toEqual(["a", "b", "c", "d"]);
  });

  it("Shift+click keeps the anchor so the range can be re-extended", () => {
    let s = applyClick({ ids: ["b"], anchor: "b" }, "d", order, { shift: true, toggle: false });
    s = applyClick(s, "c", order, { shift: true, toggle: false });
    expect(s).toEqual({ ids: ["b", "c"], anchor: "b" });
  });

  it("Ctrl+Shift adds a range to the existing selection without duplicates", () => {
    const s = applyClick({ ids: ["a", "c"], anchor: "c" }, "e", order, { shift: true, toggle: true });
    expect(new Set(s.ids)).toEqual(new Set(["a", "c", "d", "e"]));
    expect(s.ids.length).toBe(4);
  });

  it("Shift+click with no anchor behaves like a plain click", () => {
    expect(applyClick(EMPTY_SELECTION, "c", order, { shift: true, toggle: false })).toEqual({ ids: ["c"], anchor: "c" });
  });
});

describe("selectAll / pruneSelection / targetIds", () => {
  it("selects everything visible", () => {
    expect(selectAll(order).ids).toEqual(order);
    expect(selectAll([])).toEqual({ ids: [], anchor: null });
  });

  it("drops ids that no longer exist and repairs the anchor", () => {
    const s = pruneSelection({ ids: ["a", "b", "z"], anchor: "z" }, new Set(["a", "b", "c"]));
    expect(s).toEqual({ ids: ["a", "b"], anchor: "a" });
    const same = { ids: ["a"], anchor: "a" };
    expect(pruneSelection(same, new Set(["a"]))).toBe(same);
  });

  it("an action on a selected item applies to the whole selection, otherwise only to it", () => {
    const sel = { ids: ["a", "b", "c"], anchor: "a" };
    expect(targetIds(sel, "b")).toEqual(["a", "b", "c"]);
    expect(targetIds(sel, "e")).toEqual(["e"]);
  });
});
