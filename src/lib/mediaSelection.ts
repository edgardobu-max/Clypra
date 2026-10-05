/**
 * Multi-selection rules for the media bin (same conventions as a file explorer):
 *   click          -> select only that item
 *   Ctrl/Cmd+click -> toggle that item
 *   Shift+click    -> select the range from the anchor to the clicked item
 *   Ctrl+Shift     -> add that range to the current selection
 */

export interface MediaSelection {
  ids: string[];
  /** Item the next Shift+click extends from. */
  anchor: string | null;
}

export const EMPTY_SELECTION: MediaSelection = { ids: [], anchor: null };

export interface ClickModifiers {
  shift: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle: boolean;
}

/** `orderedIds` is the visible order of the items (what the user sees on screen). */
export function applyClick(current: MediaSelection, clickedId: string, orderedIds: string[], mods: ClickModifiers): MediaSelection {
  if (mods.shift && current.anchor && orderedIds.includes(current.anchor) && orderedIds.includes(clickedId)) {
    const a = orderedIds.indexOf(current.anchor);
    const b = orderedIds.indexOf(clickedId);
    const range = orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
    const ids = mods.toggle ? Array.from(new Set([...current.ids, ...range])) : range;
    return { ids, anchor: current.anchor };
  }

  if (mods.toggle) {
    const has = current.ids.includes(clickedId);
    return { ids: has ? current.ids.filter((id) => id !== clickedId) : [...current.ids, clickedId], anchor: clickedId };
  }

  return { ids: [clickedId], anchor: clickedId };
}

export function selectAll(orderedIds: string[]): MediaSelection {
  return { ids: [...orderedIds], anchor: orderedIds[0] ?? null };
}

/** Drops ids that no longer exist (deleted or moved out of view). */
export function pruneSelection(current: MediaSelection, existingIds: Set<string>): MediaSelection {
  const ids = current.ids.filter((id) => existingIds.has(id));
  if (ids.length === current.ids.length) return current;
  return { ids, anchor: current.anchor && existingIds.has(current.anchor) ? current.anchor : (ids[0] ?? null) };
}

/** The ids an action on `itemId` should apply to: the whole selection if the item is in it, else just the item. */
export function targetIds(current: MediaSelection, itemId: string): string[] {
  return current.ids.includes(itemId) ? current.ids : [itemId];
}
