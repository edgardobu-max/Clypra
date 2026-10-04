# Bitácora del proyecto — Clypra

Registro de sesiones de trabajo con Claude. Se actualiza al final de cada sesión con lo que se hizo, se encontró o quedó pendiente. Sirve para retomar contexto rápido sin tener que releer el historial completo del chat.

Rama de trabajo: `claude/clypra-lut-webgl-support-h86n6n`

---

## Contexto general

Clypra es un fork de `AIEraDev/clypra`, editor de video open source: Tauri v2 + Rust (backend) + React 19/TypeScript + WebGL (frontend).

Antes de esta serie de sesiones, otra instancia de Claude (en un sandbox remoto, sin GTK/WebKit/pangocairo, sin poder compilar ni correr nada) implementó tres features nuevas basándose solo en lectura de código:

1. Soporte de LUTs (.cube) para color grading vía textura 3D en WebGL2.
2. Transición Fade/Dissolve entre clips pegados en la misma pista.
3. Filtros básicos de ajuste: Brillo, Contraste, Saturación.

Esas features quedaron commiteadas (`c115b66`, `6925979`, `19a94d5`) pero **nunca se habían probado en ejecución real**. El objetivo de las sesiones registradas acá fue: instalar todo en Windows nativo, compilar, correr la app de verdad, y validar (o arreglar) esas 3 features tanto en preview como en export a MP4.

---

## Sesión 1 — Setup inicial + primeros bugs de preview

**Setup:**
- Clonado del fork (`edgardobu-max/Clypra`), checkout de la rama de LUT/WebGL.
- `npm install` sin problemas (no hizo falta Visual Studio Build Tools).
- `cargo check` falló al principio: `ffmpeg-sys-next` no encontraba FFmpeg. Se resolvió instalando FFmpeg vía **vcpkg** (`C:\vcpkg`, triplet `x64-windows`) y seteando `VCPKG_ROOT=C:\vcpkg` al compilar/correr.
- `cargo tauri dev` compiló y la app abrió por primera vez.

**Bug 1 — LUT no se aplicaba en preview (arreglado):**
- Síntoma: se podía importar un LUT y aplicarlo al clip seleccionado (UI mostraba el LUT activo), pero el preview no cambiaba visualmente.
- Causa raíz: el `<video>` oculto que usa el pipeline de preview (`src/core/resources/PreviewMediaPool.ts`) no tenía `crossOrigin = "anonymous"`. El protocolo `asset://` de Tauri se sirve como cross-origin respecto a la página, y con `Cross-Origin-Embedder-Policy: require-corp` (configurado en `tauri.conf.json`), el elemento queda "tainted" — el WebGL puede dibujar el video con Canvas2D pero no puede leer sus píxeles con `texImage2D` para aplicar el shader de color grading. Fallaba en silencio (el catch dejaba el frame sin filtro).
- Fix: agregar `video.crossOrigin = "anonymous"` **antes** de asignar `video.src` en `PreviewMediaPool.ts`.

**Bug 2 — LUT se veía verticalmente invertido (arreglado):**
- Después del fix anterior, el LUT ya se aplicaba pero la imagen salía dada vuelta.
- Causa: el shader de `src/core/render/lut/webglLutProcessor.ts` no compensaba que WebGL sube texturas con el origen abajo-izquierda, mientras el canvas/video las entrega con la fila superior primero.
- Fix: invertir la coordenada V en el vertex shader (`v_uv.y = 1.0 - (...)`).

**Transiciones y ajustes de color:** una vez arreglado el LUT, se probaron y funcionaron sin cambios adicionales — Fade/Dissolve y Brillo/Contraste/Saturación ya andaban bien en preview.

**Export a MP4 — bloqueado:** al intentar exportar, la app mostraba "FFmpeg is required" a pesar de que `ffmpeg -version` funcionaba perfecto desde la terminal. Diagnóstico: **os error 216** ("no es compatible con la versión de Windows") al invocar `ffmpeg` desde dentro del proceso de Rust. Quedó sin resolver al final de la sesión (se sospechaba, incorrectamente en ese momento, que era un problema con el symlink de WinGet).

---

## Sesión 2 — Audio en preview + arranque del export

**Bug 3 — Sin audio en el preview (arreglado):**
- Síntoma: el video se reproducía visualmente bien pero nunca se escuchaba nada, sin importar el estado de mute/volumen.
- Diagnóstico (con DevTools de la app vía F12 — hubo que agregar el feature `devtools` a `tauri = { features: [...] }` en `Cargo.toml`, no estaba habilitado): consultando el DOM se vio que el `<video>` primario (el no-muteado) quedaba con `paused: true` **todo el tiempo**, incluso mientras el reloj de reproducción avanzaba con normalidad.
- Causa raíz: en `PreviewMediaPool.ts`, la rama de "video pausado" reasignaba `video.currentTime` en **cada** ciclo de sync (que corre en cada tick del reloj, ~60/s durante playback). Como el tiempo objetivo avanza en cada frame, esto mantenía al video en un loop perpetuo de re-seek, y nunca le daba tiempo a `video.play()` de completarse de verdad.
- Fix: solo forzar el seek cuando el video está pausado **y** la diferencia de tiempo es significativa (>0.05s), en vez de en cada tick.
- Nota: costó bastante descubrir esto porque el servidor de Vite quedó varias veces sirviendo código viejo cacheado en memoria (no bastaba con guardar el archivo ni con recargar la página — hacía falta matar el proceso de `cargo tauri dev` entero y relanzarlo). Si un fix de frontend "no hace nada" después de guardarlo, sospechar de esto primero.

**Export — diagnóstico del bug de FFmpeg:**
- Se agregó logging temporal en `check_ffmpeg_available` (Rust) para ver el PATH real que ve el proceso y probar la ruta absoluta de ffmpeg.
- Confirmado: **la ruta absoluta funciona perfecto**, pero `Command::new("ffmpeg")` (búsqueda por PATH) siempre falla con error 216 en este entorno — sin importar si el symlink de WinGet está antes o después en el PATH.
- Causa raíz real (encontrada recién en la sesión 3): el propio repo tiene un **stub de desarrollo roto**. `src-tauri/bin/ffmpeg-x86_64-pc-windows-msvc.exe` es en realidad un **script batch de texto** (`@echo off ... where ffmpeg && ...`) con extensión `.exe`, pensado como wrapper temporal ("Dev helper: runs ffmpeg from PATH") hasta reemplazarlo por un binario real. Tauri copia este sidecar a `target\debug\ffmpeg.exe`, y como esa carpeta está en el PATH del proceso, la búsqueda por nombre lo encuentra ahí antes que el FFmpeg real. Windows no puede ejecutar un archivo batch-con-extensión-.exe vía `CreateProcess` (que es lo que usa `Command::new` de Rust) — de ahí el error 216, que en realidad no tiene nada que ver con arquitectura de CPU.

---

## Sesión 3 — Export funcionando de punta a punta

**Fix del stub de FFmpeg (arreglado):**
- Se agregó `resolve_ffmpeg_path()` en `src-tauri/src/commands/export.rs`: busca manualmente en el PATH, pero **valida que el archivo encontrado tenga cabecera PE válida ("MZ")** antes de aceptarlo — si no la tiene (como el stub batch), sigue buscando en el resto del PATH. Se usa en las 3 invocaciones de ffmpeg/ffprobe (`export.rs` y `media.rs`).

**Cancelar export no funcionaba (arreglado):**
- Existía una ref `exportAbortRef` en `ExportDialog.tsx` declarada pero nunca leída ni seteada en `true` — funcionalidad a medio implementar.
- Fix: se agregó `shouldCancel` a la config de `exportVideo()` (`src/lib/videoExport.ts`), chequeado en cada iteración del loop de frames; y un botón real de Cancelar en la fase "exporting" del diálogo que setea la ref.

**Export extremadamente lento (85 min para un clip de 31s) — arreglado en 2 pasos:**
1. El export mandaba cada frame como `Array.from(imageData.data)` (~8M elementos) a Rust vía `invoke()`, que Tauri serializa como JSON — carísimo. Cambiarlo a pasar el `ArrayBuffer` directo **no ayudó** (Tauri lo sigue serializando igual en este setup).
2. La mejora real: pedirle al `FrameScheduler` el frame como **PNG comprimido** (`outputFormat: "blob"`, ya existía como opción) en vez de RGBA crudo, y cambiar el input de ffmpeg de `-f rawvideo -pixel_format rgba` a `-f image2pipe -vcodec png`. Esto bajó el export de **0.2 fps → ~9 fps** (de 85 min a ~1:45 min para el mismo clip).

**Video exportado salía en negro (arreglado):**
- Causa: `VideoElementPool.ts` (usado solo para export) pasaba la ruta cruda de Windows (`C:\Users\...\video.mp4`) directo a `video.src`, sin convertirla con `convertFileSrc()` de Tauri como sí hace `PreviewMediaPool.ts`. El navegador no podía cargar el video → frames en negro.
- Fix: convertir con `convertFileSrc()` antes de pasarla al pool, y agregar el mismo `crossOrigin = "anonymous"` que en preview (mismo problema potencial con el shader de color grading en export).

**Video exportado salía a 10-20x de velocidad (arreglado):**
- Al intentar acelerar el export evitando el seek-por-frame (dejando el video reproduciendo continuo y solo esperando a que llegue al tiempo objetivo con `requestVideoFrameCallback`), el resultado se reprodujo mucho más rápido de lo real.
- Causa: la reproducción real avanza en tiempo de reloj real (wall-clock), independiente de cuánto tarde el resto del pipeline en procesar cada frame. Como el procesamiento por frame tardaba más que la duración de un frame, el video real seguía avanzando de fondo y terminábamos capturando frames cada vez más adelantados.
- Fix: se revirtió a hacer **seek exacto (hard seek) en cada frame**, que es correcto para exportación cuadro-por-cuadro. No hacía falta la optimización — el cuello de botella real ya estaba resuelto con el fix de PNG.

**Resultado final:** export a MP4 funcionando de punta a punta — LUT, transición y ajustes de color se ven correctamente en el archivo final, a velocidad razonable (~9 fps, un clip de 31s tarda ~1:45 min).

---

## Pendientes conocidos (no bugs de esta sesión, features nunca implementadas)

- **Audio en el export final:** el pipeline de export nunca mezcló audio — está literalmente comentado como "(future)" en el header de `export.rs` desde el código original. El audio del preview sí funciona (bug arreglado arriba), pero el MP4 exportado no lleva sonido.
- **Transiciones más dinámicas:** actualmente solo existe Fade/Dissolve. El usuario comentó que se ve "sosa" — quedó pendiente evaluar agregar slide/zoom/wipe u otras.

## Archivos modificados (sin commitear al cierre de la sesión 3)

- `src-tauri/Cargo.toml` — feature `devtools` agregado.
- `src-tauri/src/commands/export.rs` — `resolve_ffmpeg_path()`, PNG en vez de rawvideo.
- `src-tauri/src/commands/media.rs` — usa `resolve_ffmpeg_path()` para ffmpeg/ffprobe.
- `src/components/ui/ExportDialog.tsx` — botón Cancelar funcional.
- `src/core/render/lut/webglLutProcessor.ts` — flip vertical del shader.
- `src/core/resources/PreviewMediaPool.ts` — `crossOrigin`, fix de re-seek infinito.
- `src/core/resources/VideoElementPool.ts` — `convertFileSrc`, `crossOrigin`.
- `src/lib/videoExport.ts` — PNG blob en vez de RGBA, `shouldCancel`.

**Importante:** estos cambios siguen sin commitear. Antes de cerrar el tema definitivamente, hay que decidir con el usuario si se commitean/pushean.

---

## Análisis de brechas (2026-10-04) — qué le falta a Clypra

Caso de uso objetivo declarado por el usuario: **reels de noticias de 30-60 s** a partir de videos base, voz en off y música de fondo propios (de la marca), con **título en los primeros 10 s**, **subtítulos** y **miniatura**. También sigue vigente el canal infantil (clips + canción).

**Corrección a una afirmación previa:** Clypra *sí* usa Python — `src/features/text-effects/transcribe.py` (openai-whisper, modelo `tiny`) lo invoca el comando Rust `transcribe_audio_local` vía `uv run`.

### Ya existe y sirve
- Multi-pista, trim, undo/redo, guardado de proyecto, selector de formato (9:16/16:9/1:1).
- Texto con plantillas (Title Card, Lower Third, Broadcast, Social, Caption…) y estilos (stroke, fondo, alineación).
- Pestaña Captions: importar SRT/VTT a pista de texto + auto-captions con Whisper.
- LUT, brillo/contraste/saturación, transiciones Fade/Dissolve, export a MP4 (con PNG por IPC, ~9 fps).

### Brechas — prioridad alta (bloquean el flujo de reels)
1. **El MP4 exportado no lleva audio** (nunca implementado; `export.rs` solo mete video por stdin). Hace falta mezclar voz + música (+ audio de los clips) con FFmpeg.
2. **No hay volumen por clip/pista ni fades de audio**: `evaluator.ts` fija `volume: 1.0`; `Clip` y `Track` no tienen campo de volumen. Sin esto no se puede bajar la música bajo la voz. (Después: ducking automático.)
3. **Auto-captions hoy fallarían en esta PC**: `uv` no está instalado (python 3.12 sí). Además `tiny` es muy débil en español; evaluar `faster-whisper` con modelo `small`/`medium`. El script se ubica por ruta relativa al cwd → no funcionaría en una app empaquetada.
4. **Sin miniatura**: no existe "exportar frame como PNG" ni miniatura con título superpuesto.

### Brechas — prioridad media
5. **Título primeros 10 s**: posible hoy a mano (clip de texto de 10 s), pero no hay preset de un clic. Verificar que las plantillas funcionen offline (`templateStore` intenta una API y cae a plantillas estáticas).
6. **Pestaña Audio con datos falsos** (efectos y músicas hardcodeados en `AudioTab.tsx`, sin archivos reales).
7. **Posible desajuste de formato en export**: el diálogo mostró Canvas 1080×1920 con Resolution 1920×1080 (presets horizontales). Verificar que un proyecto 9:16 exporte vertical; faltan presets 1080×1920.
8. **Bundle de release roto**: `src-tauri/bin/ffmpeg-*` son stubs batch con extensión `.exe`; con `externalBin` el instalador los empaquetaría y el export fallaría. Hacen falta binarios estáticos reales (o apoyarse en `resolve_ffmpeg_path`).
9. Más transiciones (usuario: Fade/Dissolve "sosa") — slide, zoom, wipe.

### Brechas — prioridad baja / futuro
- Velocidad de clip, keyframes/animaciones, estabilización, subtítulos con palabra resaltada, atajos.
- Tests automáticos para los fixes de esta serie (hoy solo validados a mano).

### Deuda de trabajo
- 8 archivos modificados **sin commitear** en la rama `claude/clypra-lut-webgl-support-h86n6n` (ver sesión 3). Decidir commit/push al fork.

---

## Sesión 4 (2026-10-04) — Audio en el export + volumen/fades

### Hecho
- **Export con audio**: `src/lib/exportAudio.ts` decide qué audio entra (clips de audio + audio de video; salta pistas mute/ocultas, texto, imágenes); `export.rs` mezcla con FFmpeg (`atrim/asetpts/volume/afade/adelay/amix normalize=0/alimiter`), AAC 192k (PCM en ProRes), `-t` = frames/fps.
- **Volumen y fades por clip** (`Clip.volume` 0–1, `audioFadeIn/Out`), sección Audio en Propiedades; `src/lib/audioGain.ts` compartido por preview y export para que suenen igual.
- Tests: `audioGain` (6), `exportAudio` (6), `audio_filter_tests` en Rust (6).
- `assetProtocol.scope.allow` ahora cubre `C:/**` … `Z:/**` (antes un WAV en `D:\` no se podía cargar). Decisión explícita del usuario.

### Bugs encontrados
- **Audio de pista sola no sonaba en preview**: `updateAudioElement` reasignaba `currentTime` en cada tick → `readyState` caía a 1 → nunca se llamaba `play()` (exigía `readyState >= 3`). Mismo bug que ya tenía el video. Arreglo: seek solo con deriva real (0.5 s reproduciendo / 0.05 s pausado) y `play()` sin gate de readyState.
- `<audio>` sin `crossOrigin="anonymous"` (COEP require-corp) → añadido por coherencia con el video.
- Pistas en **mute** guardadas en el proyecto (el export las omite igual que el preview): si "no suena", mirar primero el botón de mute.
- Mono → estéreo con `pan=stereo|c0=c0|c1=c0` (aformat atenúa 3 dB). stderr de ffmpeg: `-nostats -loglevel warning` para no llenar el pipe en exports largos.

### Técnica de diagnóstico útil
- Comando temporal Rust `debug_log` + `invoke` desde el front imprime en la terminal de `tauri dev` (sin abrir F12). Se quitó al terminar.
- `tauri dev`: si el puerto 1420 queda ocupado, matar el Vite huérfano; los procesos en background mueren por timeout (usar timeout largo).

### Pendiente
- Verificar con ffprobe un MP4 exportado con audio (stream presente, duración, nivel).
- Siguiente: subtítulos funcionales (uv + faster-whisper), miniatura + preset de título, presets 9:16, ffmpeg real para release.

### Sesión 4 (cont.) — Velocidad de export y zoom
- **Export 3.3× más rápido** (521 frames: 505 s → 155 s, 1.0 → 3.4 fps). Medido por etapa (ms/frame): ipc 602, render+PNG 156, seek 126. Causa: `write_export_frame` recibía `Vec<u8>` → Tauri lo serializa como arreglo JSON de ~900k números. Ahora el PNG va como cuerpo binario crudo (`tauri::ipc::Request`, id de sesión en header `x-session-id`) y el progreso vuelve como valor de retorno (ya no hay `Channel`). IPC bajó a ~53 ms.
- Restante por frame: seek ~140, render+PNG ~128, ipc ~53. Siguiente: solapar el seek del frame N+1 con render/envío del N (~6–7 fps), probar `h264_nvenc` (el ffmpeg local lo trae), y a futuro export en segundo plano estilo CapCut.
- ffmpeg PNG→x264 fast aislado: ~60 ms/frame (no es el cuello).
- **Zoom del timeline**: rango 25–400 px/s → 5–1600 px/s (`DEFAULT_SRP_CONFIG` L0.min 0.05, L3.max 16). Ctrl+rueda ya existía.
- Lección: editar archivos Rust con `tauri dev` en marcha reinicia la app y mata un export en curso. Esperar a que termine.
- Técnica: comando temporal `debug_log` + cronómetros dieron los números (ya retirados).

### Intento fallido: pipelining del export (revertido)
- Se probó doble pool de `<video>` (seek del frame N+1 mientras se renderiza N) + envío async del frame. Resultado: 182.6 s (2.9 fps), más lento que la versión secuencial (155 s, 3.4 fps), y el usuario notó peor calidad de salida. Revertido a la versión secuencial con IPC binario (0260dc2).
- Si se retoma: probar `h264_nvenc` o reducir el costo del PNG antes de volver a solapar seeks.
