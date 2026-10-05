import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/useMediaImport", () => ({ useMediaImport: () => ({ importMedia: vi.fn(), isLoading: false, toastMessage: null, clearToast: vi.fn() }) }));
vi.mock("@/hooks/useFileDrop", () => ({ useFileDrop: () => ({ containerRef: { current: null }, isDraggingOver: false }) }));

import { MediaTab } from "../MediaTab";
import { useProjectStore } from "@/store/projectStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useUIStore } from "@/store/uiStore";
import type { MediaAsset, Project } from "@/types";

const asset = (id: string, folderId: string | null = null): MediaAsset => ({ id, name: `${id}.mp4`, path: `C:/m/${id}.mp4`, type: "video", duration: 5, size: 1, posterFrame: `poster-${id}.png`, folderId });
const project = (): Project => ({ id: "p", name: "P", createdAt: 0, updatedAt: 0, aspectRatio: "9:16", canvasWidth: 1080, canvasHeight: 1920, frameRate: 30, duration: 0, mediaFolders: [{ id: "f1", name: "Base" }] }) as Project;

function renderBin() {
  return render(
    <DndProvider backend={HTML5Backend}>
      <MediaTab onAddToTimeline={vi.fn()} />
    </DndProvider>,
  );
}

const card = (name: string) => screen.getByText(`${name}.mp4`).closest("div[class*='group']") as HTMLElement;
const dataTransfer = () => {
  const data: Record<string, string> = {};
  return { data, setData: (k: string, v: string) => (data[k] = v), getData: (k: string) => data[k] ?? "", setDragImage: vi.fn(), types: [] as string[], effectAllowed: "all", dropEffect: "move", files: [] as unknown as FileList, items: [] as unknown as DataTransferItemList };
};

describe("media bin: multi-selection and folders", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: project(), mediaAssets: [asset("a"), asset("b"), asset("c"), asset("d")] });
    useTimelineStore.setState({ tracks: [], clips: [] });
    useUIStore.setState({ previewMediaId: null, previewMode: "program", selectedClipIds: [] });
  });

  it("Ctrl+click builds a selection and shows the selection bar", () => {
    renderBin();
    fireEvent.click(card("a"), { ctrlKey: true });
    fireEvent.click(card("c"), { ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("Shift+click selects a range", () => {
    renderBin();
    fireEvent.click(card("a"));
    fireEvent.click(card("c"), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("Ctrl+A selects every visible item", () => {
    const { container } = renderBin();
    fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: "a", ctrlKey: true });
    expect(screen.getByText("4 selected")).toBeInTheDocument();
  });

  it("'Move to…' moves the whole selection into the folder in one go", () => {
    renderBin();
    fireEvent.click(card("a"), { ctrlKey: true });
    fireEvent.click(card("b"), { ctrlKey: true });
    fireEvent.change(screen.getByLabelText("Move selected media to a folder"), { target: { value: "f1" } });
    const byId = Object.fromEntries(useProjectStore.getState().mediaAssets.map((m) => [m.id, m.folderId ?? null]));
    expect(byId).toEqual({ a: "f1", b: "f1", c: null, d: null });
    // the moved items leave the top-level view and the selection is pruned
    expect(screen.queryByText("a.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("Delete removes every selected item", () => {
    const { container } = renderBin();
    fireEvent.click(card("b"), { ctrlKey: true });
    fireEvent.click(card("d"), { ctrlKey: true });
    fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: "Delete" });
    expect(useProjectStore.getState().mediaAssets.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("dragging a selected card onto a folder moves the whole selection", () => {
    renderBin();
    fireEvent.click(card("a"), { ctrlKey: true });
    fireEvent.click(card("b"), { ctrlKey: true });
    const dt = dataTransfer();
    const folder = screen.getByLabelText("Folder Base");
    const dragged = card("a"); // grab it now: after the drop it leaves this view
    fireEvent.dragStart(dragged, { dataTransfer: dt });
    fireEvent.dragEnter(folder, { dataTransfer: dt });
    fireEvent.dragOver(folder, { dataTransfer: dt });
    fireEvent.drop(folder, { dataTransfer: dt });
    fireEvent.dragEnd(dragged, { dataTransfer: dt });
    const byId = Object.fromEntries(useProjectStore.getState().mediaAssets.map((m) => [m.id, m.folderId ?? null]));
    expect(byId).toEqual({ a: "f1", b: "f1", c: null, d: null });
  });

  it("dragging an unselected card moves only that card", () => {
    renderBin();
    fireEvent.click(card("a"), { ctrlKey: true });
    const dt = dataTransfer();
    const folder = screen.getByLabelText("Folder Base");
    const dragged = card("c");
    fireEvent.dragStart(dragged, { dataTransfer: dt });
    fireEvent.dragEnter(folder, { dataTransfer: dt });
    fireEvent.dragOver(folder, { dataTransfer: dt });
    fireEvent.drop(folder, { dataTransfer: dt });
    fireEvent.dragEnd(dragged, { dataTransfer: dt });
    const byId = Object.fromEntries(useProjectStore.getState().mediaAssets.map((m) => [m.id, m.folderId ?? null]));
    expect(byId).toEqual({ a: null, b: null, c: "f1", d: null });
  });
});

describe("media bin: inside a folder", () => {
  it("dropping on 'All media' moves items back to the top level", () => {
    useProjectStore.setState({ project: project(), mediaAssets: [asset("a", "f1"), asset("b", "f1"), asset("c")] });
    renderBin();
    fireEvent.click(screen.getByLabelText("Folder Base"));
    const root = screen.getByText("All media");
    const dt = dataTransfer();
    const dragged = card("a");
    fireEvent.click(dragged, { ctrlKey: true });
    fireEvent.dragStart(dragged, { dataTransfer: dt });
    fireEvent.dragEnter(root, { dataTransfer: dt });
    fireEvent.dragOver(root, { dataTransfer: dt });
    fireEvent.drop(root, { dataTransfer: dt });
    fireEvent.dragEnd(dragged, { dataTransfer: dt });
    const byId = Object.fromEntries(useProjectStore.getState().mediaAssets.map((m) => [m.id, m.folderId ?? null]));
    expect(byId.a).toBeNull();
    expect(byId.b).toBe("f1");
    // keep `within` referenced for future assertions on the open folder
    expect(within(document.body)).toBeTruthy();
  });
});
