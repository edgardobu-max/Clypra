import React, { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Trash2 } from "lucide-react";
import type { TabProps } from "./types";
import { useLutStore } from "@/store/lutStore";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";
import { loadParsedLut, type LutAsset } from "@/lib/lutLibrary";
import { getLutProcessor } from "@/core/render/lut/webglLutProcessor";

const THUMB_W = 96;
const THUMB_H = 54;

/** A small synthetic reference image (hue sweep + skin-tone bar) so a LUT's
 * look can be judged without needing a project clip loaded. Built once and
 * reused for every thumbnail. */
function buildReferenceImage(): ImageBitmap | HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext("2d")!;

  const hueGrad = ctx.createLinearGradient(0, 0, THUMB_W, 0);
  hueGrad.addColorStop(0, "#e04b4b");
  hueGrad.addColorStop(0.33, "#4be06b");
  hueGrad.addColorStop(0.66, "#4b7fe0");
  hueGrad.addColorStop(1, "#e0c94b");
  ctx.fillStyle = hueGrad;
  ctx.fillRect(0, 0, THUMB_W, THUMB_H * 0.6);

  const skinGrad = ctx.createLinearGradient(0, 0, THUMB_W, 0);
  skinGrad.addColorStop(0, "#3a2a20");
  skinGrad.addColorStop(0.5, "#c99873");
  skinGrad.addColorStop(1, "#f2d9c0");
  ctx.fillStyle = skinGrad;
  ctx.fillRect(0, THUMB_H * 0.6, THUMB_W, THUMB_H * 0.4);

  return canvas;
}

let _referenceImage: ImageBitmap | HTMLCanvasElement | null = null;
function getReferenceImage() {
  if (!_referenceImage) _referenceImage = buildReferenceImage();
  return _referenceImage;
}

const LutThumbnail: React.FC<{ lut: LutAsset }> = ({ lut }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const processor = getLutProcessor();
        const canvas = canvasRef.current;
        if (!processor || !canvas) return;
        const parsed = await loadParsedLut(lut);
        if (cancelled) return;
        const result = processor.apply(getReferenceImage() as CanvasImageSource, THUMB_W, THUMB_H, { lutId: lut.id, lut: parsed, lutIntensity: 1.0 });
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(result, 0, 0);
      } catch (err) {
        console.error(`[LutsTab] Failed to render thumbnail for ${lut.name}:`, err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lut]);

  if (failed) {
    return <div className="w-full aspect-video rounded bg-surface-raised flex items-center justify-center text-[10px] text-text-muted">Error</div>;
  }

  return <canvas ref={canvasRef} width={THUMB_W} height={THUMB_H} className="w-full aspect-video rounded bg-black object-cover" />;
};

export const LutsTab: React.FC<TabProps> = () => {
  const { luts, loading, error, refresh, importFromDialog, removeLut } = useLutStore();
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const clips = useTimelineStore((s) => s.clips);
  const updateClip = useTimelineStore((s) => s.updateClip);

  const selectedClip = useMemo(() => clips.find((c) => c.id === selectedClipIds[0]), [clips, selectedClipIds]);
  const activeLutId = (selectedClip as any)?.lutId as string | undefined;
  const activeIntensity = ((selectedClip as any)?.lutIntensity as number | undefined) ?? 1.0;

  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyToSelectedClip = (lutId: string | undefined) => {
    if (!selectedClip) return;
    updateClip(selectedClip.id, { lutId, lutIntensity: lutId ? activeIntensity : undefined } as any);
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3 flex flex-col gap-3">
      <button onClick={() => importFromDialog()} disabled={loading} className="flex items-center justify-center gap-2 p-2 rounded-lg bg-accent/10 hover:bg-accent/20 text-accent text-sm font-medium transition-colors cursor-pointer disabled:opacity-50">
        <Upload size={14} />
        {loading ? "Importando..." : "Importar LUT (.cube)"}
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {!selectedClip && <p className="text-xs text-text-muted">Selecciona un clip en el timeline para aplicarle un LUT.</p>}

      {selectedClip && activeLutId && (
        <div className="flex flex-col gap-1 p-2 rounded-lg bg-surface-raised">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-primary">Intensidad</span>
            <span className="text-xs text-text-muted">{Math.round(activeIntensity * 100)}%</span>
          </div>
          <input type="range" min={0} max={1} step={0.01} value={activeIntensity} onChange={(e) => updateClip(selectedClip.id, { lutIntensity: parseFloat(e.target.value) } as any)} className="w-full" />
          <button onClick={() => applyToSelectedClip(undefined)} className="mt-1 text-xs text-text-muted hover:text-red-400 self-start cursor-pointer">
            Quitar LUT
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {luts.map((lut) => (
          <div key={lut.id} className={`relative group rounded-lg overflow-hidden border ${activeLutId === lut.id ? "border-accent" : "border-transparent"}`}>
            <button onClick={() => applyToSelectedClip(lut.id)} disabled={!selectedClip} className="w-full text-left cursor-pointer disabled:cursor-not-allowed">
              <LutThumbnail lut={lut} />
              <p className="text-xs text-text-primary px-1.5 py-1 truncate">{lut.name}</p>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeLut(lut.id);
              }}
              className="absolute top-1 right-1 p-1 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              title="Eliminar LUT"
            >
              <Trash2 size={12} className="text-white" />
            </button>
          </div>
        ))}
      </div>

      {!loading && luts.length === 0 && <p className="text-xs text-text-muted">No hay LUTs importados todavia.</p>}
    </div>
  );
};
