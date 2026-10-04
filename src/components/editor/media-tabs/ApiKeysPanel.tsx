import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { KEY_PROVIDERS, listSavedKeyProviders, removeApiKey, saveApiKey, type KeyProviderId } from "@/features/subtitles/providers";

/** Save/remove provider API keys. Values go straight to Rust and are never shown again. */
export const ApiKeysPanel: React.FC = () => {
  const [saved, setSaved] = useState<KeyProviderId[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<KeyProviderId, string>>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listSavedKeyProviders()
      .then(setSaved)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const save = async (id: KeyProviderId) => {
    setError(null);
    try {
      await saveApiKey(id, drafts[id] ?? "");
      setDrafts((d) => ({ ...d, [id]: "" }));
      refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  const remove = async (id: KeyProviderId) => {
    setError(null);
    try {
      await removeApiKey(id);
      refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  return (
    <details className="rounded-lg border border-border/50 bg-surface-raised/40 p-2.5 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-text-primary">
        <KeyRound className="w-3.5 h-3.5 text-accent" />
        API keys ({saved.length} saved)
      </summary>
      <div className="mt-2 space-y-2.5">
        <p className="text-[10px] leading-snug text-text-muted">Stored only on this computer (app config folder). Saved keys are never shown again; the engines that use them are connected progressively.</p>
        {KEY_PROVIDERS.map((p) => {
          const has = saved.includes(p.id);
          return (
            <div key={p.id} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary">{p.label}</span>
                {has && (
                  <span className="flex items-center gap-1 text-[10px] text-green-400">
                    <Check className="w-3 h-3" /> saved
                  </span>
                )}
              </div>
              <p className="text-[10px] leading-snug text-text-muted">{p.purpose}</p>
              <div className="flex gap-1.5">
                <input type="password" autoComplete="off" spellCheck={false} placeholder={has ? "Replace key…" : "Paste key…"} value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-text-primary outline-none" aria-label={`${p.label} API key`} />
                <Button variant="secondary" size="sm" disabled={!(drafts[p.id] ?? "").trim()} onClick={() => save(p.id)}>
                  Save
                </Button>
                {has && (
                  <Button variant="secondary" size="sm" onClick={() => remove(p.id)} aria-label={`Remove ${p.label} key`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {error && <p className="text-[10px] text-red-400">{error}</p>}
      </div>
    </details>
  );
};
