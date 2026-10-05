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

### Sesión 4 (cont.) — Subtítulos (auto-captions)
- Instalado `uv` (winget `astral-sh.uv`). `src/features/text-effects/transcribe.py` ahora usa **faster-whisper** (modelo `small`, CPU int8, `vad_filter`, idioma auto o `es`), con timestamps por palabra agrupados en líneas cortas (≤38 caracteres / ≤3 s, sin palabra huérfana final). Probado con voz TTS en español: transcripción correcta con acentos, ~13 s para 11 s de audio (primera vez descarga ~480 MB del modelo).
- Bug de PyAV (`open() got an unexpected keyword argument 'metadata_errors'`) al dejar que faster-whisper decodifique: ahora el script decodifica con ffmpeg a 16 kHz mono float32 y pasa un array numpy.
- stdout forzado a UTF-8 (Rust lo lee como UTF-8; en Windows el pipe usa ANSI).
- `media.rs`: `resolve_uv_path()` (PATH → `~/.local/bin` → WinGet Links/Packages) porque la app lanzada antes de instalar `uv` conserva el PATH viejo.
- `TextTab.tsx`: si hay clips seleccionados, el auto-caption transcribe SOLO esos (voz en off) en vez de todos (la música daba basura).
- Pendiente: script empaquetado para release (se busca por ruta relativa al cwd), selector de idioma/modelo en UI, estilo de subtítulos para reels (hoy `neon-crimson`).

### Sesión 4 (cont.) — Auto-captions en la UI y edición múltiple
- Auto Captions ahora está en la pestaña **Captions** (antes solo en Text > sub-panel): idioma Español/English/Auto, usa todas las pistas de audio/video **sin mute** (silenciar el audio del video para captionar solo la voz en off); si hay selección, solo esos clips. Lógica en `src/features/subtitles/autoCaptions.ts`.
- Bug: `WinError 216` en Whisper → el script llamaba `ffmpeg` por PATH y tomaba el stub de `src-tauri/bin`; ahora Rust pasa `FFMPEG_PATH` (resolve_ffmpeg_path).
- **Paneles redimensionables** (`ResizeHandle` + `usePersistentSize`, localStorage): panel izquierdo, derecho y alto del timeline. Barra de pestañas con wrap (antes se cortaba Captions).
- **Selección múltiple**: Ctrl+A (todos los clips), Ctrl+Shift+A (misma pista del primer seleccionado), botón "Select all captions". Propiedades: con varios clips del mismo tipo seleccionados, estilo/posición se aplican a todos en un solo paso de undo (`CompositeCommand`); `text/startTime/duration/trim` solo al primario.

### Sesión 4 (cont.) — Mover varios clips y selección por arrastre
- Arrastrar en el visor con varios clips del mismo tipo seleccionados ahora mueve **todos** (antes solo el principal, por eso unos subtítulos "quedaban en su sitio"). `TransformOverlay.tsx`: `groupStartRef` + `CompositeCommand` (un solo undo).
- **Selección por arrastre (marquee)** en el timeline: mantener y arrastrar sobre espacio vacío de las pistas selecciona los clips tocados (Shift/Ctrl suma). Por debajo de la regla (24 px); el click posterior al arrastre no limpia selección ni mueve el playhead.

### Sesión 4 (cont.) — Subtítulos desde guion + estructura para APIs
- **Alineación forzada con guion** (`transcribe.py`, `align_script`): el texto de los subtítulos sale del guion pegado (nombres, tildes, puntuación exactos) y los tiempos del audio (Whisper word timestamps + `difflib.SequenceMatcher` sobre palabras normalizadas; palabras sin pareja se reparten entre sus vecinas). Devuelve `aligned` y `matchedRatio`; la UI avisa si <85 % coincide. Probado con TTS (Sabina es-MX) con palabras extra en el guion: 86 % y nombres correctos. No requiere API ni internet.
- UI en Captions: selector de motor, caja de guion opcional, panel plegable "API keys".
- **Almacén de claves** (`commands/api_keys.rs`): `set_api_key / delete_api_key / list_api_key_providers`; guarda `api_keys.json` en el app config dir (texto plano; mover a la bóveda del SO antes de distribuir). El front nunca recibe los valores. `read_api_key` queda para llamadas desde Rust.
- **Motores** (`features/subtitles/providers.ts`): `local-whisper` implementado; `gemini` (gemini-3.5-transcribe, custom_vocabulary ≤1000 términos, NO combinable con timestamps por palabra), `openai-whisper` (whisper-1 es el único de OpenAI con timestamps; gpt-transcribe no), `elevenlabs-scribe` → marcados "coming soon". Anthropic: sin entrada de audio; uso previsto = corrección de texto.
- Investigación de modelos (2026-10-04): ver conversación; Gemini 3.5 Transcribe ≈0.005 USD/min, WER ~4 %.
- Pendiente: probar con un audio real de ElevenLabs + su guion (es y en); implementar motores remotos y corrección con Claude; glosario de nombres.

### Sesión 4 (cont.) — Cajas de subtítulos y interlineado
- Síntoma: subtítulos largos se envolvían en 3 líneas y se cortaban (caja angosta + alto fijo). Causa: `createTextClip` medía el ancho de UNA línea y fijaba el alto en 1.5×fontSize; el motor (`@clypra/engine`) envuelve el texto al ancho de la caja pero dibuja en un canvas del alto de la caja.
- Arreglos: (1) `rasterizer.ts` mide el texto con `computeTextLayout` y agranda la superficie de dibujo alrededor del centro si el texto envuelto necesita más alto (ya no corta líneas); (2) control **Line Spacing** (0.8–2.0) en Text Style (aplica a toda la multi-selección); (3) subtítulos nuevos con `boxWidthRatio: 0.9` (ancho 90 % del lienzo, alto de 2 líneas); (4) botón "Widen all caption boxes to fit the screen" para los ya creados.

### Sesión 4 (cont.) — Caja de texto flexible
- Síntoma: con fuente pequeña el subtítulo cabe, al agrandarla la línea se desborda y se corta por los lados (la superficie de dibujo era del tamaño fijo de la caja del clip). Reproducido en página de prueba: el motor (`@clypra/engine`) dibuja bien con caja fija solo si su medición coincide con el dibujo.
- Arreglo en `rasterizer.ts` (`rasterizeTextLayer`): el texto se envuelve en el propio rasterizador contra el ancho de la caja (con la misma fuente), se pasa al motor con saltos de línea y `wrapText:false`, y la superficie de dibujo crece (ancho y alto, centrada) hasta lo que el texto necesita (+8 % de holgura de ancho). Ya no hay recorte.
- Nota de entorno: el efecto `neon-crimson` no existe en la API (`/effects/neon-crimson` → "Effect not found"), así que los subtítulos usan siempre el camino de texto plano.
- Nota de herramienta: en este entorno los `\n` dentro de heredocs de Python llegan como saltos de línea reales → usar la herramienta Edit o `String.fromCharCode(10)` al escribir literales con backslash.

### Sesión 4 (cont.) — Orden de pistas
- Problema: la música de fondo se insertaba justo bajo la PRIMERA pista de video (encima de la voz en off, o incluso sobre el video principal si había overlays), porque `getInsertIndexForNewTrack` usaba `findIndex(video)+1` para audio.
- Nueva regla: video/texto nuevos arriba del todo; audio nuevo **debajo de la última pista de audio** (o bajo todas las visuales si no hay audio) → cada audio nuevo queda debajo del anterior. `sortTracksVisualFirst` + acción `arrangeTracks` + botón "Arrange tracks" en la barra del timeline para ordenar proyectos existentes (visuales arriba, audio abajo, orden relativo conservado). Tests: `src/store/__tests__/trackOrder.test.ts`.

### Sesión 4 (cont.) — Cabeceras de pista con el scroll
- Las cabeceras (candado/ojo/volumen) no seguían el scroll vertical de las pistas. Ahora `Timeline.handleScroll` copia `scrollTop` a `TrackList` (root con `overflow-hidden`, `pb-3` para igualar el rango) y la rueda sobre las cabeceras desplaza el área de pistas.

### Sesión 4 (cont.) — Portada (cover) estilo CapCut
- Flujo del usuario en CapCut: coloca el título sobre un frame a mano → abre "Selecciona una portada" → elige el frame (tira de miniaturas, o pestaña "Local" con imagen propia) → guarda. El editor de plantillas/IA de CapCut NO se necesita.
- Implementado: botón **Cover** (icono imagen) en la barra del timeline → `CoverDialog.tsx`: visor con el frame compuesto (todas las pistas visibles + títulos + marca), slider de frame ±1 frame (parte del cabezal), pestañas "From video" / "Local image", "Set as cover", "Export image…" (PNG/JPG al tamaño del proyecto), "Remove cover".
- `Project.cover` (`{kind:"frame",time}` | `{kind:"image",path}`): tipos TS, `serialization.ts`, `projectStore.setCover` (autoguardado) y campo `cover: Option<Value>` en el struct Rust.
- `src/lib/frameRender.ts` (`renderFrameBlob`, `pngToJpegBlob`) y comando Rust `save_image_file` (cuerpo binario + header `x-path` percent-encoded; solo .png/.jpg).
- Al exportar el video, si el proyecto tiene portada de frame se guarda `<video>_cover.png` al lado (se muestra en el resumen). Portada de imagen local: aún no se copia junto al video.
- Pendiente: tira de miniaturas en vez de slider, portada local junto al video, miniatura en la cabecera de la pista principal.

### Sesión 4 (cont.) — Títulos de marca con animación de entrada
- Pedido: título prediseñado (caja azul oscuro/dorado, texto blanco en mayúsculas), 10 s, entra deslizándose desde la izquierda con rebote leve, salida BRUSCA (sin animación de salida), movible como los subtítulos.
- `src/lib/introAnimation.ts`: `ClipIntro {type: none|slide-left|slide-up|fade, duration, bounce}`; `getIntroState` devuelve offsets dx/dy/opacity que el evaluador SUMA a x/y/opacity del clip → no choca con mover/estilizar el clip (por eso no se usaron keyframes absolutos). `easeOutBack` con c1=0.9 (overshoot leve). Tests: `introAnimation.test.ts`.
- `TextClip.intro` + `TextClip.background.{opacity,borderColor,borderWidth}` (el motor ya soportaba `panelOpacity`/`panelStroke*`; `rasterizer.panelExtras` los mapea).
- `src/lib/titlePresets.ts`: 3 looks (News navy+oro, News negro+rojo, Clean headline) y `createTitleClip` (tamaño de fuente y caja como % del lienzo → sirve en 9:16/16:9/1:1; arriba al 20 %).
- UI: sub-pestaña **Titles** en Text (`TitlesPanel.tsx`): look, titular, entrada, duración → "Add title at playhead" en una pista de texto "Titles". En Text Style: selector "Entrance animation" + Bounce + duración.
- Pendiente: afinar colores con la marca real del usuario (la captura era pequeña); presets de usuario guardados por marca; descargar plantillas Lottie (no hecho).

### Sesión 4 (cont.) — Caja del título demasiado grande en el preview
- Causa: el motor lee `panelPaddingX/Y`, `panelRadius`, `panelStrokeWidth`, `strokeWidth` y `shadow*` en píxeles crudos; el texto se escalaba con el visor pero estos valores no, así que con el preview reducido la caja se veía enorme (en el export a escala 1 se veía bien). `rasterizer.panelExtras(layer, scaleY)` ahora escala todos con la fuente. Relleno del preset 28 → 20 px.

### Sesión 4 (cont.) — Transiciones
- Síntoma: "no hay ninguna activa aunque selecciono los videos". Causa: el evaluador y la pestaña exigían que los clips estuvieran pegados a <1 ms; en el proyecto real hay pequeños huecos/solapes (p. ej. 0.06 s) → la pestaña quedaba deshabilitada. Ahora la tolerancia es 0.15 s (`TRANSITION_CUT_TOLERANCE`) y se puede seleccionar cualquiera de los dos clips del corte (se aplica al segundo).
- Nuevas: **Slide** (el clip entrante empuja al saliente hacia la izquierda, easeInOut) y **Zoom** (el entrante entra con zoom 1.25→1 y fundido), además de Dissolve y Fade. Lógica pura en `src/core/evaluation/transitionState.ts` (+ tests); el evaluador aplica `dx`/`scale` a la geometría de la capa de media. Funciona en preview y export (mismo evaluador).
- Pendiente: Wipe/Spin/Blur; transición de audio (crossfade) no implementada.
- Nota: ClipDragDrop.test "renders clips on track" puede dar timeout (5 s) cuando la suite corre en paralelo con carga; pasa sola.

### Sesión 4 (cont.) — Carpetas en el panel de medios (Import Media)
- Caso de uso: 6 proyectos (4 propios + 2 de clientes), cada uno con sus medias de marca fijas (logo, música de fondo, marquilla) en una carpeta "Base"; tras exportar se borran videos y voz en off y el proyecto queda listo para el siguiente video.
- Modelo: `MediaAsset.folderId` y `Project.mediaFolders [{id,name}]` (TS, `serialization.ts`, y `media_folders: Vec<Value>` en el struct Rust). Acciones en `projectStore`: `createMediaFolder / renameMediaFolder / deleteMediaFolder / moveMediaToFolder` (borrar una carpeta devuelve sus medias al nivel superior; carpeta inexistente ⇒ nivel superior).
- UI (`MediaTab.tsx`): botón "New folder", tarjetas de carpeta (icono + nombre + nº de elementos), entrar/volver ("All media / Base"), importar dentro de la carpeta abierta (también por arrastrar-soltar), menú contextual del medio: "Move to «carpeta»" / "Move out of folder"; menú contextual de carpeta: renombrar / borrar.
- Pendiente (no pedido): botón "limpiar timeline y dejar lista la plantilla", arrastrar medios sobre una carpeta, copiar el proyecto como plantilla.

### Sesión 4 (cont.) — Ejecutable de escritorio y MediaDesk IA
- **Build de release (Windows):** `VCPKG_ROOT="C:\vcpkg" npx tauri build --config src-tauri/tauri.release.conf.json` → `src-tauri/target/release/clypra.exe` (23 MB) y instalador NSIS `src-tauri/target/release/bundle/nsis/Clypra_1.0.1_x64-setup.exe` (10.7 MB). `tauri.release.conf.json` quita los sidecars `externalBin` (en el repo son stubs) y limita el bundle a NSIS; el ffmpeg/ffprobe se toman del PATH (`resolve_ffmpeg_path`). Smoke test: el exe arranca y responde.
- El script `transcribe.py` ahora se empaqueta como recurso (`bundle.resources` → `transcribe/transcribe.py`) y `transcribe_audio_local` lo resuelve con `BaseDirectory::Resource` antes de las rutas de desarrollo. Requisitos en el equipo: ffmpeg en PATH y `uv` instalado (la primera transcripción descarga faster-whisper y el modelo ~480 MB).
- Pendiente para distribuir a terceros (clientes): ffmpeg/ffprobe reales como sidecars (no commitear binarios de >100 MB; descargarlos en CI), firmar el instalador, empaquetar `uv`/Python o un motor de transcripción propio.
- **MediaDesk IA = `content-panel-pro`** (repo local `C:\Users\edgar\Documents\Projects\content-panel-pro\content-panel`, remoto `github.com/edgardobu-max/content-panel-pro`), desplegado en **panel.muzikali.com** (el dominio panel.muzikalirecords.com del reporte era la primera versión). Express en Hostinger, ZIP manual. Integración propuesta: por archivos (Clypra exporta MP4 + portada → SocialDesk publica) y/o botón "Enviar al panel" con `x-api-secret`; Clypra es de escritorio (WebGL/ffmpeg local), no corre en el VPS.

---

## Sesión 5 (2026-10-04, noche) — Lista de tareas del VPS/administrador

### Banco de pruebas (reutilizable)
- Lanzar la app con depuración remota: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" VCPKG_ROOT="C:\vcpkg" npm run tauri dev`. Un cliente CDP mínimo (Node 24, `WebSocket` nativo) evalúa JS en la ventana de la app: importa `/src/store/*.ts` y `/src/lib/videoExport.ts`, carga un proyecto con `invoke("load_project")` + `loadProject` y lanza `exportVideo` con `profile` → ms/frame por etapa. **Cuidado:** editar fuentes del front recarga la página y pierde el proyecto cargado (cargar y medir en la misma llamada); **el instalador NSIS cierra cualquier `clypra.exe` en ejecución** (mata la instancia de pruebas). Scripts en el scratchpad de la sesión (`cdp.mjs`, `run_bench.sh`).
- `exportVideo({ profile })` acepta un objeto opcional que acumula ms de `seek / render(+PNG) / encode(arrayBuffer) / ipc`.

### 1.1 Velocidad — línea base REAL (proyecto de noticias 1080×1920, 6 s = 181 frames, preset fast, crf 23, libx264)
| corrida | fps | seek | render+PNG | ipc/escritura ffmpeg |
|---|---|---|---|---|
| 1 | 1.66 | 231 | 238 | 93 |
| 2 | 2.36 | 133 | 197 | 70 |
| 3 | 1.58 | 169 | 229 | 89 |
| 4 | 2.00 | 159 | 233 | 78 |
(ms/frame; la variación entre corridas es ~±25 %, usar ≥3 corridas). La cifra de 3.4 fps anterior era con otro proyecto (horizontal/ligero); este (vertical, subtítulos, título, 1920p) es más pesado.
- **NVENC no disponible en esta PC** (solo Intel HD 630; `h264_nvenc`/`h264_amf` fallan al abrir el encoder). `h264_qsv` (Quick Sync) funciona. Medido con `encoder:"auto"` → QSV: 1.93 y 1.95 fps → **sin mejora** frente a libx264 (media 1.9). El encoder no es el cuello (ffmpeg PNG→x264 aislado ~16 fps).
- Implementado igualmente: detección real del encoder por prueba (`detect_hardware_h264`, cacheada) con NVENC→QSV→AMF y caída a libx264; **opt-in** (`encoder:"auto"`), por defecto `software` para calidad predecible. Útil en equipos NVIDIA (sin medir aquí).
- Pendiente de medir: costo del PNG (render+PNG ≈ 200-230 ms es el mayor), seeks.

### 1.1 Velocidad — experimentos de formato de frame y solapamiento de IPC (mismo banco, 6 s, ms/frame)
| variante | fps (corridas) | seek | render(+PNG) | ipc |
|---|---|---|---|---|
| PNG secuencial (actual) | 2.31, 2.20, 2.07 | ~134 | 205-246 | 74-86 |
| RGBA crudo secuencial | 2.00, 2.05 | 136 | **91** | **238** |
| PNG + envío solapado | 2.15, 1.98 | 143-164 | 259-308 | 6-42 |
| RGBA + envío solapado | **2.47, 2.43** | 129-132 | 220-228 | 31 |
| RGBA + solapado + preset veryfast | 2.66 | 132 | 207 | 27 |
- Codificar el PNG cuesta ~120 ms/frame (render baja de ~210 a ~91 con píxeles crudos) pero mover 8.3 MB por IPC cuesta ~240 ms: neto igual. Solapar el envío solo gana ~+15 % con RGBA y nada con PNG (el render sube porque ffmpeg/x264 y el webview compiten por la CPU).
- **RGBA crudo es peligroso en esta PC (7.9 GB de RAM, ~1.1 GB libres):** la instancia de pruebas murió con `0xe0000008` (sin memoria) a mitad de una corrida RGBA+solapado. Conclusión: **por defecto se queda PNG secuencial + libx264**; `frameFormat:"rgba"` y `overlapIpc` quedan como opciones experimentales desactivadas (documentadas en `ExportConfig`).
- El cuello real es CPU (seek de `<video>` + raster en el webview + x264 en el mismo procesador). Un salto grande (>2×) exigiría decodificar/componer fuera del webview (Rust/ffmpeg) o más RAM/CPU; no es un cambio pequeño.

### 2. Tests rotos — causa real y arreglo
- Síntoma: `ClipFilmstrip.integration` (4 tests), `Track.test` "prevents clip selection when track is locked", y a veces `ClipDragDrop`/`Clip.test`, fallan con timeout de 5 s **cuando la PC está cargada** (dev app + build corriendo; solo ~1 GB de RAM libre de 7.9). Con la PC libre pasan.
- Causa: **no era el componente ni el test.** jsdom pinta los canvas con el paquete nativo `canvas` (node-canvas), que se carga en la **primera** llamada a `getContext()` (`ClipFilmstrip` monta un canvas): ~1.15 s en frío, varias veces más con carga. Se midió con un test mínimo (`getContext("2d")` #1 = 1151 ms, #2 = 0 ms) y bisecando el render de `Track` (con `ClipFilmstrip` mockeado: 22 ms; sin mock: ~1300 ms).
- Arreglo (sin subir timeouts): `src/test-setup.ts` precalienta `document.createElement("canvas").getContext("2d")` al arrancar cada archivo de **tests de componentes** (rutas con `/components/`), fuera del tiempo de cualquier test. Probado bajo carga artificial (4 procesos quemando CPU): **sin** el arreglo fallan 7 tests (justo los reportados); **con** él pasan los 80 de `timeline/`. Suite completa: **58 archivos / 674 tests en verde, 2 corridas seguidas** (~100 s).
- Descartado: anular `getContext` (null) rompe `lottie-web`, que usa el contexto real al importarse; calentar en todos los archivos duplicaba la duración de la suite (140 s).

### 1.2 Formato vertical y presets
- Bug confirmado: los 5 presets del diálogo eran fijos 1920×1080/1280×720/3840×2160 aunque el proyecto fuera 1080×1920 → el export pedía el render a otro aspecto. Ahora `src/lib/exportSizes.ts` (`exportSizeForShortSide`, tests) define cada preset por su **lado corto** (720 / 1080 / 2160) y deriva el largo del lienzo, con dimensiones pares: 9:16 → 720×1280 / 1080×1920 / 2160×3840; 16:9 → 1280×720 / 1920×1080 / 3840×2160; 1:1 → 720² / 1080² / 2160²; 4:5 → 1080×1350. El diálogo (`ExportDialog.tsx`) recalcula nombre/resolución al cambiar el formato del proyecto y muestra "Format: Horizontal/Vertical/Square".
- Verificado con ffprobe sobre un export real del proyecto de noticias: `width=1080 height=1920`.

### 1.3 / 1.4 Audio, cancelación y errores (Rust, `export.rs`)
- Nuevo módulo de pruebas `export_pipeline_tests` (4 tests que ejercen el pipeline real: `start_video_export` → `write_frame_bytes` → `finalize/cancel`, y miden con ffprobe/ffmpeg; se saltan solos si no hay ffmpeg): (a) MP4 con voz+música tiene stream de audio, **duración de audio = duración de video** (3.000 s ambos) y **sin clipping**; (b) sin fuentes de audio → sin stream de audio; (c) cancelar **borra el archivo parcial** y cierra la sesión; (d) si FFmpeg falla (carpeta de salida inexistente) el error menciona FFmpeg y no queda archivo.
- **Bug hallado por la prueba:** con fuentes a escala completa el mix llegaba a **0 dBFS** (`alimiter` en 0.97 + overshoot de AAC). Techo bajado a `limit=0.89` (−1 dBFS) → pico medido −0.60 dBFS.
- Sesiones: `ExportSession.output_path`; `cancel_video_export` mata, espera (sin zombis) y borra el parcial; si falla `write` (FFmpeg murió) `abort_session` mata/recoge, borra el parcial y devuelve las últimas líneas de stderr; `finalize` en error borra el parcial y resume stderr; `kill_on_drop(true)` + `stdout: null`; `cancel_all_exports()` al destruirse la ventana (`on_window_event`) para no dejar FFmpeg huérfano ni archivos a medias.

### 1.5 Portada local junto al video
- `src/lib/coverExport.ts` (`exportCoverNextToVideo`, `coverPathForVideo`, `localImageToPngBlob`, `saveImageBytes`): al terminar un export, si el proyecto tiene portada se guarda `<video>_cover.png` al lado — de **frame** (render del timeline a tamaño del proyecto) **o de imagen local** (decodificada y recodificada a PNG, así el nombre/formato es siempre el mismo sea jpg, webp o png). `ExportDialog` usa este módulo; si falla muestra "Cover image could not be saved." sin invalidar el video.

### 5. Seguridad y dependencias (parcial: falta validar el CSP en el build de release)
- **Claves de API en la bóveda del SO:** `api_keys.rs` ahora usa el crate `keyring` (Windows Credential Manager / macOS Keychain / Secret Service; dependencias por plataforma en `Cargo.toml`). El front sigue sin poder leer los valores. **Migración automática:** si existe el `api_keys.json` viejo (texto plano) sus claves se pasan a la bóveda y el archivo se borra (solo si todas se guardaron bien). Tests: validación de ids y round-trip real con la bóveda (escribe/lee/borra una credencial de prueba).
- **API upstream:** `docs/UPSTREAM_API.md` documenta qué se pierde sin ella. Hallazgo: **`ALL_TEMPLATES` (el "fallback estático") está VACÍO**, así que offline la pestaña Templates no tiene nada; ahora muestra un mensaje claro y apunta a la pestaña Titles (que sí funciona offline). Test `offlineFallback.test.ts` verifica que el store cae al fallback sin romperse.
- **CSP:** ver el estado más abajo.

### 3. Empaquetado de release — HALLAZGO CRÍTICO y arreglo
- **El instalador anterior estaba roto:** `clypra.exe` enlaza dinámicamente las DLL de FFmpeg de vcpkg (`avcodec-62`, `avformat-62`, `avutil-60`, `swscale-9`, …) y el NSIS no las incluía → al abrir la app instalada Windows se queda en el diálogo "falta avcodec-62.dll" (proceso de 4 MB, 4 hilos, **sin ventana**). En dev funciona porque las DLL están accesibles. El "smoke test" anterior (solo comprobar que el proceso vive) no lo detectó: **hay que comprobar que exista la ventana**.
- Arreglo: `scripts/stage-ffmpeg-dlls.ps1` copia las DLL de `%VCPKG_ROOT%\installed\x64-windows\bin` a `src-tauri/ffmpeg-dlls/` (gitignored) y `tauri.release.conf.json` las instala junto al exe (`resources: {"ffmpeg-dlls/*": "./"}`). Comando: **`npm run build:release`** (stage + `tauri build` con la config de release; sin sidecars `externalBin`). Instalador: 17.4 MB; carpeta instalada: exe 22 MB + 7 DLL (~21 MB) + `transcribe/transcribe.py`.
- **Probado en la app INSTALADA** (CDP en el exe instalado): ventana presente; `check_ffmpeg_available` OK (ffmpeg 8.1 del PATH); **export real** (90 frames PNG + audio) → ffprobe: h264 128×128, aac, **ambas pistas 3.000 s**, pico −3.9 dBFS; **subtítulos** con el `transcribe.py` empaquetado + `uv` + guion → `aligned: true, matchedRatio: 1`; abrir el proyecto de noticias y recorrer las pestañas (Text, Transitions, LUTs, Captions, Audio, Media, Templates, Effects, Titles).
- Decisión pendiente con el usuario: **ffmpeg.exe CLI** (usado por el export y el audio) se toma del PATH; las DLL de enlace sí van empaquetadas. Para clientes sin FFmpeg hay que bundlear `ffmpeg.exe`/`ffprobe.exe` reales (descargarlos en CI, no commitear >100 MB) o exigir FFmpeg instalado. Tampoco se empaqueta `uv`.
- VC++ Redistributable: las DLL de FFmpeg resuelven contra el sistema de esta PC; en equipos limpios puede hacer falta el VC++ Redistributable.

### 5. CSP — validado en el build de release
- `tauri.conf.json`: `csp` estricto (`default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src` solo IPC + protocolo asset + API upstream + raw.githubusercontent + Google Fonts, `img-src/media-src` con `blob:`/`asset:`/`data:`, `object-src 'none'`, `frame-src 'none'`) y `devCsp` aparte (con `ws://localhost:1420` y `unsafe-eval` para Vite).
- Validación en el exe instalado: **0 violaciones** al cargar, abrir el proyecto y visitar pestañas; sondas: `fetch` a un origen externo **bloqueado**, protocolo asset **ok**, imagen/worker `blob:` **ok**, WebGL2 **ok**.
- Hallazgo ajeno al CSP: el API upstream bloquea por **CORS** el origen `http://tauri.localhost` (ver `docs/UPSTREAM_API.md`) → efectos/plantillas en línea no cargan en la app de escritorio, con o sin clave.

### 4. Higiene del repo y cierre de la sesión 5
- `.claude/` añadido al `.gitignore`; `media.rs` y `tauri.conf.json` ya estaban commiteados (sin pendientes). `src-tauri/ffmpeg-dlls/` gitignored (se genera con el script).
- Rama principal del fork = **`master`** (no existe `main`). La rama de trabajo `claude/clypra-lut-webgl-support-h86n6n` quedó por delante de `origin/master` (master era ancestro → avance rápido) y se integró con `git push origin HEAD:master`.
- Copia vieja `C:\Users\edgar\Documents\Clypra`: **NO borrada**, pendiente de confirmación explícita del usuario.
- Estado final: `tsc` limpio; vitest **61 archivos / 683 tests** en verde; `cargo test --lib` **75 tests** en verde (incluye 4 de pipeline de export con ffmpeg real y 2 de la bóveda de claves).

### Velocidad de export: antes / después (esta PC: i-? con Intel HD 630, 7.9 GB RAM, proyecto de noticias 1080×1920, 6 s)
- Antes de la sesión (PNG secuencial + libx264): **~2.0 fps** (1.58–2.36 en 4 corridas).
- Después: **sin mejora práctica con la configuración por defecto** (se mantiene PNG secuencial + libx264). Lo medido: NVENC no existe aquí; QSV ≈ 1.9 fps (igual); RGBA crudo ≈ 2.0 (igual); mejor combinación RGBA + envío solapado + `veryfast` ≈ 2.4–2.7 fps (+15–30 %) pero **mató la app por falta de memoria** en una corrida, por eso queda desactivada. El cuello es CPU compartida (seek de `<video>` + raster + x264).
- (Referencia histórica de esta misma noche: IPC binario 1.0 → 3.4 fps en el proyecto anterior, más ligero.)

### Decisiones del usuario (2026-10-04) y cierre del empaquetado
- **ffmpeg/ffprobe empaquetados (decisión: sí):** `scripts/stage-ffmpeg-dlls.ps1` ahora deja en `src-tauri/ffmpeg-runtime/` (gitignored) las DLL de vcpkg **+ `ffmpeg.exe` y `ffprobe.exe` reales** (tomados del PATH, build Gyan "full", ~213 MB c/u, autónomos: no importan las DLL `avcodec`); `tauri.release.conf.json` los instala junto a `clypra.exe`. `resolve_ffmpeg_path` busca **primero junto al exe** y luego en el PATH (`find_executable_in`, con 2 tests). Instalador resultante: **127.7 MB** (carpeta instalada ~470 MB). Licencia: el build "full" de Gyan es GPL → solo uso personal/no redistribuir sin revisar.
- **Probado en la app instalada con el PATH SIN FFmpeg:** `check_ffmpeg_available` → ffmpeg 8.1 (el empaquetado); export real → ffprobe `video 3.000 s + audio 3.000 s`; subtítulos con guion → `aligned: true, matchedRatio: 1` (usa `uv` por su ruta de respaldo y el ffmpeg empaquetado vía `FFMPEG_PATH`); CSP: solo la violación intencional de la sonda externa.
- **Copia vieja `C:\Users\edgar\Documents\Clypra` BORRADA** (con confirmación; antes se verificó: repo limpio, sin commits sin subir, rama master).
- **API upstream/CORS:** el usuario decide **no hacer nada** (uso personal; Titles y estilos de texto locales cubren su flujo). Si algún día quiere efectos/plantillas en línea: enrutar por Rust (reqwest) o pedir que permitan `http://tauri.localhost` (ver `docs/UPSTREAM_API.md`).

---

## Renombrado a **MediaDesk Editor** (2026-10-04) — versión 1.1.0
- Decisión del usuario: nombre **MediaDesk Editor** (basado en Clypra). Se renombró solo lo **visible**: `productName` y título de ventana (`tauri.conf.json`), pantalla de inicio, "Acerca de" (con "based on Clypra (MIT)" y enlace al original), `<title>` de `index.html`, mensajes, README (cabecera nueva con atribución y la guía de build; el README original queda debajo) y versión `1.1.0` (`tauri.conf.json`, `package.json`). `LICENSE` (MIT, "Clypra Contributors") **intacto**.
- **NO se cambió** el identificador `com.clypra.editor` (nombra la carpeta de datos `%APPDATA%\com.clypra.editor\projects` y la entrada de la bóveda de claves): cambiarlo haría que los proyectos "desaparecieran". Tampoco el nombre del binario (`clypra.exe`) ni los paquetes internos (`@clypra/engine`, cabeceras del API).
- Instalador: `src-tauri/target/release/bundle/nsis/MediaDesk Editor_1.1.0_x64-setup.exe`; se instala en `%LOCALAPPDATA%\MediaDesk Editor`. La versión vieja "Clypra" se desinstaló (los 5 proyectos intactos: 5 antes, 5 después) y se quitó su acceso directo roto del escritorio. Comprobado: la app abre con título "MediaDesk Editor", lista los proyectos recientes, 0 violaciones de CSP, y el acceso directo del escritorio la lanza desde el Explorador.
- Nota de entorno: el instalador se ejecutó desde la app de Claude (paquete MSIX), por lo que Windows muestra la ruta de instalación bajo `AppData\Local\Packages\Claude_*\LocalCache\Local\...`; funciona igual desde el acceso directo.
- Pendiente (lo hace el usuario): renombrar el repo en GitHub (Settings → Repository name) si lo desea; GitHub redirige el enlace viejo.

### Logo nuevo (2026-10-04)
- Logo aportado por el usuario (M azul/violeta con play, tira de película y tijeras; PNG 1254² con esquinas transparentes). Se generaron todos los iconos con `npx tauri icon src-tauri/icons/source-mediadesk-1024.png` (ico/icns/png/Android/iOS/Square*) y los recursos de UI: `public/mediadesk-editor.png` (pantalla de inicio y "Acerca de") y `public/favicon.png`. `clypra.svg` ya no se referencia.
- **Trampa:** Cargo NO reincrusta el icono en el exe si solo cambia `icons/icon.ico` → el instalador salió con el icono viejo. Hay que "tocar" `src-tauri/build.rs` (`touch`) antes de `npm run build:release`. Se verifica extrayendo el icono del exe instalado (`PrivateExtractIcons`) y viéndolo, no solo comprobando que existe.
- Comprobado en la app instalada: captura de la pantalla de inicio (logo + "MediaDesk Editor" + proyectos recientes con miniaturas) y exe con el icono nuevo.

---

## Pendiente para la próxima sesión (anotado 2026-10-04)
- **Look "Mejora HD" (CapCut):** el usuario lo usa en todos sus videos (satura bien y "da más resolución"). Es un filtro propietario de CapCut, no un .cube exportable. Plan: (1) preset de un clic propio = contraste + saturación + **nitidez/claridad (sharpen)** — Clypra hoy NO tiene sharpen (solo brillo/contraste/saturación/LUT), hay que implementarlo (shader WebGL en el pipeline de color-grade, preview y export); (2) revisar fuentes de LUTs .cube gratuitos de calidad y comparar; los LUTs gratuitos que el usuario subió antes no le gustan; (3) cerrar la lista de lo básico para empezar a producir.
- Pedir al usuario: captura del MISMO fotograma en CapCut **sin** y **con** "Mejora HD" para calibrar el preset midiendo la diferencia.

---

## Sesión 6 (2026-10-05) — Observaciones del primer video de producción
Lista del usuario tras exportar su primer video para redes ("Post Muzikali News"): (1) selección múltiple de medios, (2) arrastrar medios a carpetas, (3) medios borrados siguen en el visor, (4) volumen limitado al 100 %, (5) export en carpeta por proyecto con copias numeradas, (6) portada como frame 0 dentro del video, (7) **primer frame negro**, (8) pendiente: look "Mejora HD".

### (3) Medios borrados quedaban "fantasma" — arreglado
- Causa: `removeMediaAsset` solo quitaba la entrada del bin; los clips seguían en las pistas y `previewMediaId` seguía apuntando al medio borrado (el monitor de origen lo seguía mostrando).
- `src/lib/mediaRemoval.ts` → `removeMediaFromProject(ids)`: borra el medio **y sus clips** (una transacción de undo), normaliza/limpia pistas, limpia monitor de origen y selección. El "Delete" del menú del bin lo usa. 5 tests.

### (7) Primer frame negro — causa raíz y arreglo
- Medido en el video real `D:\Videos\Post Muzikali News.mp4` (1080×1920): frame 0 ≈ solo marco dorado + logo (YAVG 34.5), frame 1 ya con video (47.3). Reproducido en la app (CDP) con `renderFrameBlob`: tiempo 0 → brillo **10**, tiempo 0.034 → **93.6**.
- Causa: `VideoElementPool.acquire` solo hace seek si `currentTime ≠ tiempo pedido`; un `<video>` recién creado ya está en 0, así que para el tiempo 0 no hay seek, el elemento sigue en `HAVE_METADATA` (readyState 1) y el código **lanzaba** "Video not ready after seek"; `videoExport` lo trata como "no se pudo cargar este video" y renderiza el frame SIN video (negro).
- Arreglo: `waitForCurrentFrame` espera `loadeddata/canplay/seeked` (timeout 8 s) en vez de lanzar. 4 tests (elemento falso que decodifica tras 40 ms, ya listo, timeout, error). Verificado: frame 0 del render = 93.5 (antes 10) y export real YAVG 96.6 en el frame 0.
- Ojo: el scheduler **cachea** el frame por (tiempo, época): tras el arreglo hay que recargar la página para no ver el frame 0 negro cacheado de antes.
- Nota de pruebas: si la app instalada del usuario está abierta, una instancia de dev comparte la carpeta de WebView2 y no abre el puerto de depuración → lanzar la de pruebas con `WEBVIEW2_USER_DATA_FOLDER` aparte (no cerrar la app del usuario).

### (1) y (2) Panel de medios: selección múltiple y arrastrar a carpetas
- `src/lib/mediaSelection.ts` (reglas tipo explorador de archivos, 9 tests): clic = solo ese; **Ctrl/Cmd+clic** alterna; **Shift+clic** rango desde el ancla (Ctrl+Shift suma el rango); **Ctrl+A** todo lo visible; **Supr/Retroceso** borra la selección; **Esc** limpia. Ctrl/Shift+clic NO cambia el monitor de origen (solo arma la selección). Las teclas del panel hacen `stopPropagation` para que el Ctrl+A global (seleccionar clips del timeline) no se dispare.
- Barra de selección ("N selected · Select all · Move to… · Delete · Clear"); el menú contextual actúa sobre toda la selección si se hace clic derecho en un elemento seleccionado ("Move 3 items to «Base»", "Delete 3 items").
- **Arrastrar a carpetas** (react-dnd, mismo tipo `MEDIA_ASSET` que ya usa el timeline): el payload lleva `assetIds` (toda la selección si la tarjeta arrastrada está en ella; si no, solo esa). `MediaFolderCard` (tile de carpeta que resalta "Drop to move here") y `MediaRootDrop` (la miga "All media": soltar ahí saca los medios de la carpeta). `projectStore.moveMediaAssetsToFolder` mueve varios en una sola actualización (un autoguardado).
- Borrar varios usa `removeMediaFromProject` (quita también sus clips del timeline; una transacción de undo) y muestra un aviso con los conteos.
- 8 tests de integración con el backend HTML5 real simulando eventos de arrastre (selección, rango, Ctrl+A, mover, borrar, arrastrar seleccionada vs no seleccionada, soltar en "All media").

### (4) Volumen por encima de 100 % (hasta 400 %)
- Antes: el slider llegaba a 100 % y `clampVolume` capaba a 1 (un `<audio>` no pasa de volumen 1). El export (Rust) ya aceptaba 0–4.
- Ahora `MAX_CLIP_VOLUME = 4` (+12 dB): slider 0–400 % con botón "100 %" de reinicio y aviso al superar 100 %. **Vista previa:** `core/resources/audioBoost.ts` enruta por Web Audio (`MediaElementSource → GainNode → compresor-limitador compartido → altavoces`) solo los elementos que necesitan >100 %; el resto sigue con `element.volume`. Las ganancias de fade multiplican el volumen amplificado. 5 tests con un AudioContext falso.
- **Bug hallado por la prueba nueva:** con UNA sola fuente de audio el limitador (`alimiter`) NO se aplicaba (el atajo "una fuente → sin mezclador" lo saltaba) → una voz en off sola al 300–400 % llegaba sin limitar al AAC y saturaba. Ahora el limitador (techo −1 dBFS) se aplica siempre.
- Medido con ffmpeg real: seno a 100 % → −20.8 dBFS; a 300 % → −11.3 dBFS (**+9.5 dB**, esperado +9.54); fuente a escala completa al 400 % → pico < −0.05 dBFS (limitado). Test Rust `volume_above_100_percent_boosts_the_export_and_the_limiter_still_prevents_clipping`.

### (5) Export en carpeta por proyecto, con copias numeradas
- El diálogo ya no pide un archivo: pide la **ubicación** (se recuerda en `localStorage` `mediadesk.exportBaseDir`) y cada export crea **su propia carpeta** con el nombre del proyecto: `Nombre`, luego `Nombre (copia 1)`, `Nombre (copia 2)`… Dentro quedan `<carpeta>.mp4` y `<carpeta>_cover.png` (el nombre de los archivos es el de la carpeta, así cada copia es única). El diálogo muestra antes de empezar "New folder: …".
- Rust (`export.rs`): `sanitize_file_name` (caracteres inválidos de Windows, puntos/espacios finales, nombres reservados CON/NUL…, máx. 80), `unique_folder_name`, comandos `preview_export_folder` (no crea nada), `create_export_folder` (usa `create_dir`, que falla si ya existe → dos exports simultáneos nunca comparten carpeta) y `remove_empty_export_folder` (si se cancela o falla, la carpeta vacía se borra; con contenido se respeta). 4 tests.
- Front: `src/lib/exportFolder.ts`; `ExportDialog` crea la carpeta al pulsar Export y la limpia si falla/cancela.

### (6) Portada como frame 0 dentro del video
- Si el proyecto tiene portada (frame o imagen local), se escribe como **primer frame (1 frame de duración)** y el audio se retrasa ese mismo frame (`startTime + 1/fps`) para mantener la sincronía. Frame: render del timeline en ese instante al tamaño del export; imagen local: dibujada a tamaño del video con ajuste "cover" (`coverFitRect`, recorte centrado). Además se sigue guardando el `_cover.png` aparte (tamaño del proyecto) porque YouTube no siempre toma el frame 0.
- `exportVideo({ coverFrame })` (solo con `frameFormat: "png"`); `buildCoverFrameBlob` en `coverExport.ts`. Tests de `coverFitRect` y `joinExportPath`.
- **Verificado en la app real con la interfaz:** 1.er export → carpeta `Untitled Project/` con `.mp4` (720×1280, 522 frames = 17.4 s) + `_cover.png` (1080×1920), YAVG del frame 0 = 98.3 (la portada) vs 96.9 (frame 1); 2.º export → `Untitled Project (copia 1)/` sin tocar el primero. Con y sin portada: 32 vs 31 frames en 1 s y el audio mantiene su duración + 1 frame.

### Banco de pruebas: trampa de HMR
- Tras editar el front, Vite sirve los módulos de la app con `?t=…`; importar `/src/store/x.ts` desde CDP crea una **segunda instancia** del store (vacía) → renders negros "fantasma". El helper `imp()` busca la URL real en `performance.getEntriesByType("resource")` y la importa tal cual.

### Cierre de la tanda 2026-10-05
- Versión **1.1.1**. `tsc` limpio; vitest **67 archivos / 720 tests** en verde; `cargo test --lib` **82 tests** en verde.
- Pendiente: look "Mejora HD" (sharpen + preset), calibrar con capturas CapCut sin/con filtro.

### Ventana de consola durante el export (v1.1.2)
- Síntoma (usuario): al exportar se abría una ventana de consola de Windows y quedaba abierta hasta terminar. Causa: la app (GUI) lanzaba ffmpeg/ffprobe/uv como procesos de consola **sin** `CREATE_NO_WINDOW` (0x08000000).
- Arreglo: `tokio_command` / `std_command` (en `export.rs`) aplican `creation_flags(CREATE_NO_WINDOW)` en Windows y se usan en los 9 puntos donde se lanzan procesos externos (export: ffmpeg, probe de audio, prueba de encoders; media: ffprobe, miniatura, extracción de audio, uv/Whisper).
- **Verificación incompleta (honesto):** en el entorno de pruebas no se pueden renderizar ventanas de consola; el control positivo (ffmpeg lanzado sin ocultar) tampoco detectó ventana, así que la medición automática (0 ventanas durante 123 muestras de un export completo; los `conhost` hijos de ffmpeg existen pero sin ventana, es lo normal con CREATE_NO_WINDOW) **no prueba nada por sí sola**. Falta la confirmación visual del usuario en su próximo export.

### Cierre (2026-10-05, v1.1.2 instalada)
- La v1.1.1 se construyó pero NO se instaló (la app del usuario estaba abierta) → los 2 videos que exportó después seguían saliendo con el primer frame negro y sin portada en el frame 0. Lección: avisar claramente "construido ≠ instalado" y pedir cierre/instalar de inmediato, no al final.
- Verificado en la app **instalada** 1.1.2 con la interfaz real: export del proyecto con video → carpeta `Untitled Project/` con `.mp4` + `_cover.png`; 522 frames; **frame 0 = portada** (diferencia media con el PNG de portada 2.2 vs 34.4 con el frame 1) y brillo 98.3 (no negro).

---

## Look "Mejora HD" (2026-10-05, v1.2.0)
- **Qué es:** preset de un clic que reproduce lo que el usuario hace en CapCut (más color + sensación de más resolución). Un LUT no puede dar nitidez, así que se añadió un **filtro de nitidez** al shader compartido de color (`webglLutProcessor.ts`): máscara de enfoque sobre la **luma** (pixel menos promedio de sus 4 vecinos a 1 píxel de SALIDA, detalle limitado a ±0.2 para evitar halos, ganancia `sharpness × 1.8`), antes de brillo/contraste/saturación/LUT. Un solo shader → vista previa y export idénticos.
- Modelo: `Clip.sharpness` (0–1) → evaluador → `EvaluatedMediaLayer.sharpness` → `hasColorGrade` → opciones del procesador. Se guarda con el proyecto como `brightness/contrast/saturation`.
- `src/lib/colorPresets.ts`: **`MEJORA_HD = { brightness 0.01, contrast 1.10, saturation 1.25, sharpness 0.60 }`** (primera calibración a ojo), `NO_ADJUSTMENTS`, `matchesPreset`, `hasAnyAdjustment`, `clampAdjustments` (6 tests).
- UI (pestaña Effects): bloque "Mejora HD" con **Aplicar a este clip / a los N seleccionados** y **Aplicar a todos los videos (N)**, marca "activa" si el clip coincide; slider **Nitidez** junto a Brillo/Contraste/Saturación; "Restablecer" limpia también la nitidez. Se quitó "Sharpen" de la lista de "próximamente".
- **Medido en un frame real (540×960):** nitidez de bordes (energía del laplaciano) 5.06 → 9.77 (+93 %), saturación media 0.363 → 0.483 (+33 %), brillo medio 95.8 → 95.4 (sin cambio). Nitidez sola (0.6): 8.9. **Export idéntico a la vista previa:** frames exportados 4.72 → 8.09 de nitidez y 0.367 → 0.484 de saturación. Inspección visual (lado a lado y recorte ampliado): colores más ricos, bordes de hojas/líneas más definidos, sin halos ni ruido evidentes.
- **Pendiente de calibración fina:** los valores son estimados; el usuario tiene que compararlos con CapCut (mismo fotograma sin / con "Mejora HD") y decir si quiere más/menos nitidez o saturación; ajustar `MEJORA_HD` o añadir 2–3 variantes (suave/normal/fuerte).
