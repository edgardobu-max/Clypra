import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, Film, Trash2, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useTimelineStore } from "@/store/timelineStore";
import { useProjectStore } from "@/store/projectStore";
import { getPlaybackClock } from "@/hooks/usePlaybackClock";
import { renderFrameBlob, pngToJpegBlob } from "@/lib/frameRender";
import { saveImageBytes } from "@/lib/coverExport";

const PREVIEW_MAX_SIDE = 960;

interface CoverDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// Re-exported for existing importers; the implementation lives in lib/coverExport.
export { saveImageBytes };

/**
 * Cover picker: choose a frame of the timeline (titles and brand elements already
 * composited on it) or a local image, keep it as the project's cover and/or export it
 * as an image at the project size.
 */
export const CoverDialog: React.FC<CoverDialogProps> = ({ isOpen, onClose }) => {
  const project = useProjectStore((s) => s.project);
  const mediaAssets = useProjectStore((s) => s.mediaAssets);
  const setCover = useProjectStore((s) => s.setCover);

  const [tab, setTab] = useState<"video" | "local">("video");
  const [time, setTime] = useState(0);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const renderToken = useRef(0);

  const frameRate = project?.frameRate ?? 30;
  const duration = isOpen ? useTimelineStore.getState().getTimelineEndTime() : 0;
  const lastFrameTime = Math.max(0, duration - 1 / frameRate);

  // Start from the project's cover if it has one, otherwise from the playhead (where the title is positioned).
  useEffect(() => {
    if (!isOpen) return;
    setMessage(null);
    const cover = project?.cover;
    if (cover?.kind === "image") {
      setTab("local");
      setLocalPath(cover.path);
      setTime(Math.min(getPlaybackClock().time, lastFrameTime));
    } else {
      setTab("video");
      setLocalPath(null);
      setTime(Math.min(cover?.kind === "frame" ? cover.time : getPlaybackClock().time, lastFrameTime));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Render the preview (debounced while scrubbing).
  useEffect(() => {
    if (!isOpen || !project) return;
    if (tab === "local") {
      setPreviewUrl(localPath ? convertFileSrc(localPath) : null);
      return;
    }
    const token = ++renderToken.current;
    const handle = setTimeout(async () => {
      try {
        const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(project.canvasWidth, project.canvasHeight));
        const { clips, tracks, epoch } = useTimelineStore.getState();
        const blob = await renderFrameBlob({ clips, tracks, assets: mediaAssets, project, epoch, time, width: Math.round(project.canvasWidth * scale), height: Math.round(project.canvasHeight * scale) });
        if (token !== renderToken.current) return;
        setPreviewUrl((old) => {
          if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
      } catch (err) {
        if (token === renderToken.current) setMessage(`Could not render this frame: ${err instanceof Error ? err.message : err}`);
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [isOpen, tab, time, localPath, project, mediaAssets]);

  useEffect(
    () => () => {
      setPreviewUrl((old) => {
        if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
        return null;
      });
    },
    [isOpen],
  );

  const chooseLocal = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false, filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (typeof picked === "string") setLocalPath(picked);
    } catch (err) {
      setMessage(`Could not open the file picker: ${err instanceof Error ? err.message : err}`);
    }
  }, []);

  const step = (frames: number) => setTime((t) => Math.min(lastFrameTime, Math.max(0, t + frames / frameRate)));

  const handleSave = () => {
    if (tab === "local") {
      if (!localPath) return setMessage("Choose an image first.");
      setCover({ kind: "image", path: localPath });
    } else {
      setCover({ kind: "frame", time });
    }
    onClose();
  };

  const handleExportImage = async () => {
    if (!project) return;
    setBusy(true);
    setMessage(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: `${project.name || "cover"}_cover.png`, filters: [{ name: "Image", extensions: ["png", "jpg"] }] });
      if (!path) return;
      const { clips, tracks, epoch } = useTimelineStore.getState();
      let blob = await renderFrameBlob({ clips, tracks, assets: mediaAssets, project, epoch, time, width: project.canvasWidth, height: project.canvasHeight });
      if (/\.jpe?g$/i.test(path)) blob = await pngToJpegBlob(blob);
      await saveImageBytes(path, blob);
      setMessage(`Saved ${path}`);
    } catch (err) {
      setMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex gap-2">
        {project?.cover && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCover(null);
              onClose();
            }}
            className="flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remove cover
          </Button>
        )}
        {tab === "video" && (
          <Button variant="secondary" size="sm" onClick={handleExportImage} disabled={busy} className="flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> {busy ? "Exporting…" : "Export image…"}
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="default" size="sm" onClick={handleSave} className="bg-accent text-white hover:bg-accent/80">
          Set as cover
        </Button>
      </div>
    </div>
  );

  const tabButton = (id: "video" | "local", label: string, Icon: typeof Film) => (
    <button onClick={() => setTab(id)} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${tab === id ? "bg-accent text-white" : "bg-surface-raised text-text-muted hover:text-text-primary"}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Select a cover" footer={footer}>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-center rounded-lg bg-black/40 p-2" style={{ height: "46vh" }}>
          {previewUrl ? <img src={previewUrl} alt="Cover preview" className="max-h-full max-w-full rounded object-contain" style={{ outline: "1px solid rgba(255,255,255,0.12)" }} /> : <span className="text-xs text-text-muted">{tab === "local" ? "Choose an image…" : "Rendering…"}</span>}
        </div>

        <div className="flex gap-2">
          {tabButton("video", "From video", Film)}
          {tabButton("local", "Local image", ImageIcon)}
        </div>

        {tab === "video" ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="icon-sm" onClick={() => step(-1)} aria-label="Previous frame">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <input type="range" min={0} max={lastFrameTime} step={1 / frameRate} value={time} onChange={(e) => setTime(Number(e.target.value))} className="grow accent-accent" aria-label="Cover frame" />
              <Button variant="secondary" size="icon-sm" onClick={() => step(1)} aria-label="Next frame">
                <ChevronRight className="w-4 h-4" />
              </Button>
              <span className="w-16 text-right font-mono text-xs text-text-primary">{time.toFixed(2)}s</span>
            </div>
            <p className="text-[10px] text-text-muted">The frame includes every visible track at that moment: place the title over it in the timeline first.</p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={chooseLocal}>
              Choose image…
            </Button>
            <span className="truncate text-xs text-text-muted">{localPath ?? "No image selected"}</span>
          </div>
        )}

        {message && <p className="text-[11px] text-text-muted">{message}</p>}
      </div>
    </Modal>
  );
};
