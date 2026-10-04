import React from "react";
import { Type, AlignLeft, AlignCenter, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DEFAULT_INTRO_DURATION, INTRO_LABELS, type IntroType } from "@/lib/introAnimation";
import { normalizeFontFamily } from "@/core/evaluation/evaluator";
import { allTextEffects } from "@/features/text-effects/registry";
import type { TextEffectDefinition } from "@/features/text-effects/types/types";
import { _buildConfig } from "@clypra/engine";
import type { TextClip } from "@/types";

interface TextStyleSectionProps {
  textClip: TextClip;
  presets: any[];
  newPresetName: string;
  setNewPresetName: (name: string) => void;
  handleUpdate: (key: string, value: any) => void;
  handleUpdateMultiple: (fields: Record<string, any>) => void;
  handleApplyPreset: (preset: any) => void;
  savePreset: (name: string, style: any) => void;
  deletePreset: (id: string) => void;
}

export const TextStyleSection: React.FC<TextStyleSectionProps> = ({ textClip, presets, newPresetName, setNewPresetName, handleUpdate, handleUpdateMultiple, handleApplyPreset, savePreset, deletePreset }) => {
  // Quick switch text effects
  const applyEffectPreset = (effect: TextEffectDefinition) => {
    handleUpdateMultiple({
      styleId: effect.id,
      fontFamily: effect.font.family,
      color: effect.fills?.[0]?.color,
      fontWeight: effect.font.weight,
      fontStyle: effect.font.style,
      stroke: effect.strokes?.[0] ? { color: effect.strokes[0].color, width: effect.strokes[0].width } : undefined,
      shadow: effect.shadows?.[0] ? { color: effect.shadows[0].color, blur: effect.shadows[0].blur, offsetX: effect.shadows[0].offsetX ?? 0, offsetY: effect.shadows[0].offsetY ?? 0 } : undefined,
    });
  };

  // Get the selected effect's definition from allTextEffects
  const effectDefinition = allTextEffects.find((e) => e.id === textClip.styleId);

  if (effectDefinition) {
    // Resolve the definition into the exact flat config the engine constructor expects!
    const effectDefaults = _buildConfig(effectDefinition, textClip.text, textClip.fontSize, textClip.width || 640, textClip.height || 360);

    // Now you have the strict defaults defined by the studio! E.g.:
    console.log("Strict Default Fill Color:", effectDefaults.fillColor);
    console.log("Strict Default Bevel Depth:", effectDefaults.bevelDepth);
    console.log("Strict Default Scanline Toggle:", (effectDefaults as any).isGlitchEffect);
  }

  return (
    <div className="space-y-5">
      {/* Text Editor Box */}
      <div>
        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider block mb-1.5 select-none">Text Content</label>
        <textarea value={textClip.text || ""} onChange={(e) => handleUpdate("text", e.target.value)} rows={3} placeholder={effectDefinition?.text || "CLYPRA"} className="w-full bg-surface-raised border border-border/80 rounded-lg p-2.5 text-xs text-text-primary outline-none focus:border-accent resize-none selectable" />
      </div>

      {/* Style Presets Library */}
      <div>
        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider block mb-2 select-none">Style Presets</label>

        <div className="space-y-3 p-3 bg-surface-raised/20 border border-border/40 rounded-xl">
          {/* Horizontal preset selection carousel */}
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
            {presets.map((preset) => (
              <div key={preset.id} className="relative shrink-0 group/preset">
                <button
                  onClick={() => {
                    handleApplyPreset(preset);
                  }}
                  className="px-3 py-2 bg-surface-raised hover:bg-surface-raised/80 border border-border/60 hover:border-accent rounded-lg text-xs font-semibold text-text-primary transition-all cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: preset.fontFamily, color: preset.color }}
                >
                  {preset.name}
                </button>

                {preset.isCustom && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deletePreset(preset.id);
                    }}
                    className="absolute -top-1.5 -right-1.5 p-0.5 bg-destructive text-white rounded-full opacity-0 group-hover/preset:opacity-100 transition-opacity hover:bg-destructive/80 cursor-pointer"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Save Current Style as Preset */}
          <div className="flex items-center gap-2 pt-2 border-t border-border/30">
            <input type="text" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} placeholder="Custom style name..." className="flex-1 min-w-0 bg-surface-raised border border-border/80 rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-accent" />
            <Button
              size="sm"
              variant="secondary"
              className="flex items-center gap-1 shrink-0"
              onClick={() => {
                if (!newPresetName.trim()) return;
                savePreset(newPresetName.trim(), {
                  fontFamily: textClip.fontFamily,
                  fontSize: textClip.fontSize,
                  fontWeight: textClip.fontWeight,
                  fontStyle: textClip.fontStyle,
                  color: textClip.color,
                  align: textClip.align,
                  valign: textClip.valign,
                  lineHeight: textClip.lineHeight,
                  letterSpacing: textClip.letterSpacing,
                  stroke: textClip.stroke,
                  shadow: textClip.shadow,
                  background: textClip.background,
                  keyframes: (textClip as any).keyframes,
                });
                setNewPresetName("");
              }}
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </Button>
          </div>
        </div>
      </div>

      {/* Typography Options */}
      <div>
        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider block mb-2 select-none">Typography</label>

        <div className="space-y-3 p-3 bg-surface-raised/20 border border-border/40 rounded-xl">
          {/* Font Family Select */}
          <div>
            <label className="text-[10px] text-text-muted block mb-1 select-none">Font Family</label>
            <select value={normalizeFontFamily(textClip.fontFamily || "Inter Variable")} onChange={(e) => handleUpdate("fontFamily", e.target.value)} className="w-full bg-surface-raised border border-border rounded px-2.5 py-1.5 text-xs text-text-primary outline-none">
              <optgroup label="System Fonts">
                <option value="Arial">Arial</option>
                <option value="Arial Black">Arial Black</option>
                <option value="Arial Rounded MT Bold">Arial Rounded MT Bold</option>
                <option value="Georgia">Georgia</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Courier New">Courier New</option>
                <option value="Impact">Impact</option>
                <option value="Verdana">Verdana</option>
                <option value="Trebuchet MS">Trebuchet MS</option>
                <option value="Palatino">Palatino</option>
              </optgroup>
              <optgroup label="Google Web Fonts">
                <option value="Inter Variable">Inter</option>
                <option value="Geist Variable">Geist</option>
                <option value="Outfit Variable">Outfit</option>
                <option value="Space Grotesk Variable">Space Grotesk</option>
                <option value="Roboto Variable">Roboto</option>
                <option value="Roboto Condensed">Roboto Condensed</option>
                <option value="Open Sans">Open Sans</option>
                <option value="Lato">Lato</option>
                <option value="Montserrat Variable">Montserrat</option>
                <option value="Raleway">Raleway</option>
                <option value="Oswald">Oswald</option>
                <option value="Playfair Display">Playfair Display</option>
                <option value="Anton">Anton</option>
                <option value="Bebas Neue">Bebas Neue</option>
                <option value="Nunito">Nunito</option>
                <option value="Poppins">Poppins</option>
                <option value="Permanent Marker">Permanent Marker</option>
                <option value="Bangers">Bangers</option>
                <option value="Press Start 2P">Press Start 2P</option>
                <option value="Dancing Script">Dancing Script</option>
                <option value="Pacifico">Pacifico</option>
              </optgroup>
            </select>
          </div>

          {/* Font Size slider */}
          <div>
            <div className="flex justify-between items-center text-[10px] text-text-muted mb-1 select-none">
              <span>Font Size</span>
              <span className="font-mono text-text-primary">{textClip.fontSize}px</span>
            </div>
            <div className="flex items-center gap-2">
              <input type="range" min="10" max="150" value={textClip.fontSize || 48} onChange={(e) => handleUpdate("fontSize", Number(e.target.value))} className="grow accent-accent" />
              <input type="number" value={textClip.fontSize || 48} onChange={(e) => handleUpdate("fontSize", Number(e.target.value))} className="w-12 bg-surface-raised border border-border rounded text-center py-0.5 text-xs text-text-primary outline-none" />
            </div>
          </div>

          {/* Entrance animation (no outro by design) */}
          <div className="space-y-1">
            <div className="flex justify-between items-center text-[10px] text-text-muted select-none">
              <span>Entrance animation</span>
              <span className="font-mono text-text-primary">{(textClip.intro?.duration ?? DEFAULT_INTRO_DURATION).toFixed(1)}s</span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={textClip.intro?.type ?? "none"}
                onChange={(e) => {
                  const type = e.target.value as IntroType;
                  handleUpdate("intro", type === "none" ? undefined : { type, duration: textClip.intro?.duration ?? DEFAULT_INTRO_DURATION, bounce: type === "slide-left" || type === "slide-up" });
                }}
                className="min-w-0 flex-1 bg-surface-raised border border-border rounded px-2 py-1.5 text-xs text-text-primary outline-none"
                aria-label="Entrance animation"
              >
                {(Object.keys(INTRO_LABELS) as IntroType[]).map((t) => (
                  <option key={t} value={t}>
                    {INTRO_LABELS[t]}
                  </option>
                ))}
              </select>
              {textClip.intro && textClip.intro.type !== "none" && (
                <label className="flex items-center gap-1 text-[10px] text-text-muted cursor-pointer">
                  <input type="checkbox" checked={!!textClip.intro.bounce} onChange={(e) => handleUpdate("intro", { ...textClip.intro, bounce: e.target.checked })} className="accent-accent" disabled={textClip.intro.type === "fade"} />
                  Bounce
                </label>
              )}
            </div>
            {textClip.intro && textClip.intro.type !== "none" && <input type="range" min="0.2" max="2" step="0.1" value={textClip.intro.duration} onChange={(e) => handleUpdate("intro", { ...textClip.intro, duration: Number(e.target.value) })} className="w-full accent-accent" aria-label="Entrance duration" />}
          </div>

          {/* Line spacing slider */}
          <div>
            <div className="flex justify-between items-center text-[10px] text-text-muted mb-1 select-none">
              <span>Line Spacing</span>
              <span className="font-mono text-text-primary">{(textClip.lineHeight ?? 1.2).toFixed(2)}</span>
            </div>
            <input type="range" min="0.8" max="2" step="0.05" value={textClip.lineHeight ?? 1.2} onChange={(e) => handleUpdate("lineHeight", Number(e.target.value))} className="w-full accent-accent" aria-label="Line spacing" />
          </div>

          {/* Weight, Italic, Alignments */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            {/* Style buttons */}
            <div className="space-y-1">
              <label className="text-[9px] text-text-muted block select-none">Font Style</label>
              <div className="flex gap-1 bg-surface-raised border border-border/60 p-0.5 rounded">
                <button onClick={() => handleUpdate("fontWeight", textClip.fontWeight === "bold" ? "normal" : "bold")} className={`flex-1 py-1 rounded text-xs font-bold transition-all ${textClip.fontWeight === "bold" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  B
                </button>
                <button onClick={() => handleUpdate("fontStyle", textClip.fontStyle === "italic" ? "normal" : "italic")} className={`flex-1 py-1 rounded text-xs italic transition-all ${textClip.fontStyle === "italic" ? "bg-accent text-white font-bold" : "text-text-muted hover:text-text-primary"}`}>
                  I
                </button>
              </div>
            </div>

            {/* Alignment buttons */}
            <div className="space-y-1">
              <label className="text-[9px] text-text-muted block select-none">Horizontal Align</label>
              <div className="flex gap-1 bg-surface-raised border border-border/60 p-0.5 rounded">
                <button onClick={() => handleUpdate("align", "left")} className={`flex-1 py-1 rounded flex items-center justify-center transition-all ${textClip.align === "left" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  <AlignLeft className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleUpdate("align", "center")} className={`flex-1 py-1 rounded flex items-center justify-center transition-all ${textClip.align === "center" || !textClip.align ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  <AlignCenter className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleUpdate("align", "right")} className={`flex-1 py-1 rounded flex items-center justify-center transition-all ${textClip.align === "right" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  <AlignRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Vertical align and letter spacing */}
          <div className="grid grid-cols-2 gap-3">
            {/* Vertical align */}
            <div className="space-y-1">
              <label className="text-[9px] text-text-muted block select-none">Vertical Align</label>
              <div className="flex gap-1 bg-surface-raised border border-border/60 p-0.5 rounded">
                <button onClick={() => handleUpdate("valign", "top")} className={`flex-1 py-1 rounded flex items-center justify-center transition-all ${textClip.valign === "top" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  <AlignStartVertical className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleUpdate("valign", "middle")} className={`flex-1 py-1 rounded flex items-center justify-center transition-all ${textClip.valign === "middle" || !textClip.valign ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  <AlignCenterVertical className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleUpdate("valign", "bottom")} className={`flex-1 py-1 rounded flex items-center justify-center transition-all ${textClip.valign === "bottom" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}>
                  <AlignEndVertical className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Letter spacing */}
            <div className="space-y-1">
              <label className="text-[9px] text-text-muted block select-none">Letter Spacing ({textClip.letterSpacing || 0}px)</label>
              <input type="number" value={textClip.letterSpacing || 0} onChange={(e) => handleUpdate("letterSpacing", Number(e.target.value))} className="w-full bg-surface-raised border border-border rounded py-1 px-2 text-center text-xs text-text-primary outline-none" />
            </div>
          </div>
        </div>
      </div>

      {/* Visual Styling Customizers */}
      <div>
        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider block mb-2 select-none">Style Customizers</label>

        <div className="space-y-3.5 p-3.5 bg-surface-raised/20 border border-border/40 rounded-xl">
          {/* Solid Text Color */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-primary select-none">Text Color</span>
            <div className="flex items-center gap-2">
              {/* Linear Gradients Quick Selectors */}
              <select
                value={(textClip.color || "#ffffff").includes(",") ? textClip.color : "solid"}
                onChange={(e) => {
                  if (e.target.value !== "solid") {
                    handleUpdate("color", e.target.value);
                  }
                }}
                className="bg-surface-raised border border-border rounded text-[10px] py-1 px-1.5 text-text-muted outline-none"
              >
                <option value="solid">Solid Color</option>
                <option value="#ffe066, #b38600">Gold Gradient</option>
                <option value="#ff3e00, #ff0077, #aa00ff">Sunset Gradient</option>
                <option value="#ff007f, #aa00ff, #00c8ff, #00ff66">Rainbow Gradient</option>
              </select>
              <input type="color" value={(textClip.color || "#ffffff").includes(",") ? "#ffffff" : textClip.color || "#ffffff"} onChange={(e) => handleUpdate("color", e.target.value)} className="w-7 h-7 bg-transparent border-0 cursor-pointer rounded overflow-hidden" />
            </div>
          </div>

          {/* Stroke / Outline options */}
          <div className="border-t border-border/40 pt-3 space-y-2">
            <div className="flex items-center justify-between select-none">
              <span className="text-xs text-text-primary font-medium">Outline / Stroke</span>
              <input
                type="checkbox"
                checked={!!textClip.stroke}
                onChange={(e) => {
                  if (e.target.checked) {
                    handleUpdate("stroke", { color: "#000000", width: 4 });
                  } else {
                    handleUpdate("stroke", undefined);
                  }
                }}
                className="rounded border-border accent-accent cursor-pointer"
              />
            </div>

            {textClip.stroke && (
              <div className="space-y-2 p-2 bg-surface-raised/40 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted">Color</span>
                  <input type="color" value={textClip.stroke.color} onChange={(e) => handleUpdate("stroke", { ...textClip.stroke, color: e.target.value })} className="w-6 h-6 bg-transparent border-0 cursor-pointer" />
                </div>
                <div>
                  <div className="flex justify-between text-[9px] text-text-muted mb-1 select-none">
                    <span>Thickness</span>
                    <span>{textClip.stroke.width}px</span>
                  </div>
                  <input type="range" min="1" max="15" value={textClip.stroke.width} onChange={(e) => handleUpdate("stroke", { ...textClip.stroke, width: Number(e.target.value) })} className="w-full accent-accent" />
                </div>
              </div>
            )}
          </div>

          {/* Outer Glow / Shadow */}
          <div className="border-t border-border/40 pt-3 space-y-2">
            <div className="flex items-center justify-between select-none">
              <span className="text-xs text-text-primary font-medium">Outer Glow / Shadow</span>
              <input
                type="checkbox"
                checked={!!textClip.shadow}
                onChange={(e) => {
                  if (e.target.checked) {
                    handleUpdate("shadow", { color: "#ff0000", blur: 15, offsetX: 0, offsetY: 0 });
                  } else {
                    handleUpdate("shadow", undefined);
                  }
                }}
                className="rounded border-border accent-accent cursor-pointer"
              />
            </div>

            {textClip.shadow && (
              <div className="space-y-2 p-2 bg-surface-raised/40 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted">Glow Color</span>
                  <input type="color" value={textClip.shadow.color} onChange={(e) => handleUpdate("shadow", { ...textClip.shadow, color: e.target.value })} className="w-6 h-6 bg-transparent border-0 cursor-pointer" />
                </div>

                <div>
                  <div className="flex justify-between text-[9px] text-text-muted mb-1 select-none">
                    <span>Blur Radius</span>
                    <span>{textClip.shadow.blur}px</span>
                  </div>
                  <input type="range" min="1" max="30" value={textClip.shadow.blur} onChange={(e) => handleUpdate("shadow", { ...textClip.shadow, blur: Number(e.target.value) })} className="w-full accent-accent" />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[9px] text-text-muted block mb-0.5 select-none">Offset X</label>
                    <input type="number" value={textClip.shadow.offsetX} onChange={(e) => handleUpdate("shadow", { ...textClip.shadow, offsetX: Number(e.target.value) })} className="w-full bg-surface-raised border border-border text-center rounded py-0.5 text-xs text-text-primary outline-none" />
                  </div>
                  <div>
                    <label className="text-[9px] text-text-muted block mb-0.5 select-none">Offset Y</label>
                    <input type="number" value={textClip.shadow.offsetY} onChange={(e) => handleUpdate("shadow", { ...textClip.shadow, offsetY: Number(e.target.value) })} className="w-full bg-surface-raised border border-border text-center rounded py-0.5 text-xs text-text-primary outline-none" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Background Box Backing */}
          <div className="border-t border-border/40 pt-3 space-y-2">
            <div className="flex items-center justify-between select-none">
              <span className="text-xs text-text-primary font-medium">Background Box</span>
              <input
                type="checkbox"
                checked={!!textClip.background}
                onChange={(e) => {
                  if (e.target.checked) {
                    handleUpdate("background", { color: "rgba(0,0,0,0.6)", padding: 12, borderRadius: 6 });
                  } else {
                    handleUpdate("background", undefined);
                  }
                }}
                className="rounded border-border accent-accent cursor-pointer"
              />
            </div>

            {textClip.background && (
              <div className="space-y-2 p-2 bg-surface-raised/40 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted">Box Color</span>
                  <input type="color" value={textClip.background.color.startsWith("rgba") ? "#000000" : textClip.background.color} onChange={(e) => handleUpdate("background", { ...textClip.background, color: e.target.value })} className="w-6 h-6 bg-transparent border-0 cursor-pointer" />
                </div>

                <div>
                  <div className="flex justify-between text-[9px] text-text-muted mb-1 select-none">
                    <span>Box Padding</span>
                    <span>{textClip.background.padding}px</span>
                  </div>
                  <input type="range" min="0" max="30" value={textClip.background.padding} onChange={(e) => handleUpdate("background", { ...textClip.background, padding: Number(e.target.value) })} className="w-full accent-accent" />
                </div>

                <div>
                  <div className="flex justify-between text-[9px] text-text-muted mb-1 select-none">
                    <span>Border Radius</span>
                    <span>{textClip.background.borderRadius}px</span>
                  </div>
                  <input type="range" min="0" max="25" value={textClip.background.borderRadius} onChange={(e) => handleUpdate("background", { ...textClip.background, borderRadius: Number(e.target.value) })} className="w-full accent-accent" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Presets Quick Switch */}
      <div>
        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider block mb-2 select-none">Quick Presets Switch</label>
        <div className="grid grid-cols-3 gap-2 bg-surface-raised/10 border border-border/40 p-2.5 rounded-xl">
          {allTextEffects.slice(0, 6).map((effect) => (
            <button
              key={effect.id}
              onClick={() => applyEffectPreset(effect)}
              className="p-2 rounded bg-surface-raised border border-border hover:border-accent text-center truncate text-[10px] text-text-primary font-bold shadow-[0_2px_4px_rgba(0,0,0,0.15)] transition-all cursor-pointer max-w-[90px]"
              style={{
                fontFamily: effect.font.family,
                color: effect.fills?.[0]?.color ?? "#ffffff",
                textShadow: effect.shadows?.[0] ? `0 0 4px ${effect.shadows[0].color}` : effect.glows?.[0] ? `0 0 4px ${effect.glows[0].color}` : "none",
              }}
            >
              {effect.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
