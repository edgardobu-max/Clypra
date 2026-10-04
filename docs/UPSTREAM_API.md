# Upstream Clypra API (effects and templates)

Clypra's **text effects** and **text templates** catalogue comes from a hosted API
(`https://clypra-worker-api.abdulkabirmusa.com`, see `src/features/text-effects/api/clypraApi.ts`).
Requests send `X-API-Key` taken from the build-time variable `VITE_CLYPRA_API_KEY`
(`.env`, not committed). Thumbnails are loaded from `raw.githubusercontent.com`.

## What works without the API / without the key / offline

| Feature | Without the upstream API |
|---|---|
| Editing, timeline, export, audio, subtitles, titles, covers, transitions, LUTs | **Unaffected.** None of them call the API. |
| **Titles tab** (branded titles, `src/lib/titlePresets.ts`) | Works: fully local. |
| Plain text clips and the text style controls (font, colour, box, stroke, shadow, entrance animation) | Work: fully local. |
| **Text Effects** (animated/styled effects such as `neon-crimson`) | **Not available.** Definitions are fetched per effect from the API. A clip that already uses an effect id falls back to plain text rendering when the definition cannot be loaded (`rasterizeTextLayer`). Note `neon-crimson`, used as the old caption style, no longer exists on the API (`/effects/neon-crimson` returns "Effect not found"), so captions always render as plain text. |
| **Templates** (Lottie text templates) | The store falls back to the bundled static set (`ALL_TEMPLATES`, `src/features/text-templates/templates/index.ts`) when the API is unreachable (covered by `__tests__/offlineFallback.test.ts`). **That bundled set is currently empty**, so offline the tab shows an explanatory message and nothing to apply. |
| Template/effect thumbnails | Show as broken/empty images offline. |

## Distribution notes

- The API key is embedded in the frontend bundle at build time: treat it as public. Do not put
  secrets in `VITE_*` variables.
- The Content-Security-Policy in `src-tauri/tauri.conf.json` allow-lists exactly this API host,
  `raw.githubusercontent.com` (thumbnails) and Google Fonts. If the API host changes, update
  `connect-src` there.
- To make the Templates tab useful offline, bundle a few static templates in
  `src/features/text-templates/templates/` and export them from `ALL_TEMPLATES`; the fallback
  will serve them without further code changes.
