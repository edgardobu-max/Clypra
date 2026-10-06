/**
 * Per-clip visual effects (blur, vignette, grain...). Each effect has one strength, 0 (off) to 1 (max).
 * They are applied by the shared WebGL color-grade shader, so the preview and the export match.
 */

export type EffectId = "blur" | "mono" | "sepia" | "vignette" | "glow" | "chromatic" | "pixelate" | "grain";

export type ClipEffects = Partial<Record<EffectId, number>>;

export interface EffectDef {
  id: EffectId;
  name: string;
  hint: string;
}

export const EFFECTS: EffectDef[] = [
  { id: "blur", name: "Desenfoque", hint: "Suaviza toda la imagen." },
  { id: "mono", name: "Blanco y negro", hint: "Quita el color." },
  { id: "sepia", name: "Sepia", hint: "Tono calido de foto antigua." },
  { id: "vignette", name: "Vineta", hint: "Oscurece los bordes." },
  { id: "glow", name: "Brillo (glow)", hint: "Halo suave alrededor de las luces." },
  { id: "chromatic", name: "Cromatico", hint: "Separa los colores en los bordes." },
  { id: "pixelate", name: "Pixelar", hint: "Convierte la imagen en bloques." },
  { id: "grain", name: "Ruido (grano)", hint: "Grano de pelicula." },
];

export const EFFECT_IDS: EffectId[] = EFFECTS.map((e) => e.id);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Valid, non-zero strengths only; `undefined` when nothing is on. */
export function cleanEffects(fx: ClipEffects | undefined | null): ClipEffects | undefined {
  if (!fx) return undefined;
  const out: ClipEffects = {};
  for (const id of EFFECT_IDS) {
    const v = fx[id];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[id] = clamp01(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function hasAnyEffect(fx: ClipEffects | undefined | null): boolean {
  return cleanEffects(fx) !== undefined;
}

/** The effects with `id` set to `value` (0 removes it). Returns undefined when nothing is left on. */
export function withEffect(fx: ClipEffects | undefined, id: EffectId, value: number): ClipEffects | undefined {
  return cleanEffects({ ...(fx ?? {}), [id]: value });
}

/** Keeps the stronger of each effect, e.g. to add a transition's blur on top of the clip's own. */
export function boostEffects(fx: ClipEffects | undefined, boost: ClipEffects | undefined): ClipEffects | undefined {
  if (!boost) return cleanEffects(fx);
  const merged: ClipEffects = { ...(fx ?? {}) };
  for (const id of EFFECT_IDS) {
    const b = boost[id];
    if (typeof b === "number") merged[id] = Math.max(merged[id] ?? 0, b);
  }
  return cleanEffects(merged);
}
