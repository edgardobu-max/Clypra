/**
 * Video Export Commands
 *
 * FFmpeg-based video export with progress tracking and cancellation.
 *
 * Architecture:
 *   Frontend (Frame Scheduler) → Tauri Command → FFmpeg Process → MP4/MOV
 *
 * Key features:
 * - Streaming frame input (no temp files)
 * - Progress tracking via channel
 * - Cancellation support
 * - Multiple codec support (H.264, H.265, ProRes)
 * - Audio mixing (future)
 */
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// `CREATE_NO_WINDOW`: without it Windows opens a console window for every console program a GUI
/// app starts (ffmpeg, ffprobe, uv), and during an export that window stays open until it ends.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A tokio `Command` that never shows a console window on Windows.
pub fn tokio_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// A std `Command` that never shows a console window on Windows.
pub fn std_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}


/// Export progress update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// Current frame number
    pub current_frame: u32,
    
    /// Total frames to export
    pub total_frames: u32,
    
    /// Progress (0.0 - 1.0)
    pub progress: f64,
    
    /// Estimated time remaining in seconds
    pub eta_seconds: f64,
    
    /// Current FPS (frames per second)
    pub fps: f64,
}

/// Export configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfig {
    /// Output file path
    pub output_path: String,
    
    /// Video width
    pub width: u32,
    
    /// Video height
    pub height: u32,
    
    /// Frame rate
    pub frame_rate: f64,
    
    /// Total frames to export
    pub total_frames: u32,
    
    /// Video codec (h264, h265, prores)
    pub codec: String,
    
    /// Quality preset (ultrafast, fast, medium, slow, veryslow)
    pub preset: String,
    
    /// CRF quality (0-51, lower = better quality)
    pub crf: u32,
    
    /// Pixel format (yuv420p, yuv444p)
    pub pixel_format: String,

    /// "software" (default): libx264. "auto": use a working hardware H.264 encoder if the
    /// machine has one (NVENC, Quick Sync, AMF), else libx264. Hardware is opt-in because on the
    /// dev PC (Intel HD 630, Quick Sync) it was not faster than libx264 (see BITACORA).
    #[serde(default)]
    pub encoder: Option<String>,

    /// How frames arrive on stdin: "png" (default, one PNG per frame) or "rgba" (raw
    /// width*height*4 bytes per frame, no image codec on either side).
    #[serde(default)]
    pub frame_format: Option<String>,

    /// Audio sources on the timeline (voice-over, music, video audio),
    /// already clipped to the export range. Empty = silent video.
    #[serde(default)]
    pub audio_inputs: Vec<AudioInput>,
}

fn default_volume() -> f64 {
    1.0
}

fn default_speed() -> f64 {
    1.0
}

/// ffmpeg's `atempo` only accepts 0.5..=2.0 per instance, so larger/smaller factors are chained
/// (4x = 2x * 2x, 0.25x = 0.5x * 0.5x). Pitch is preserved. Empty for speed 1.
pub fn atempo_chain(speed: f64) -> String {
    let mut remaining = speed.clamp(0.25, 8.0);
    if (remaining - 1.0).abs() < 1e-6 {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    while remaining > 2.0 + 1e-9 {
        parts.push("atempo=2.000000".to_string());
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-9 {
        parts.push("atempo=0.500000".to_string());
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > 1e-6 {
        parts.push(format!("atempo={:.6}", remaining));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(",{}", parts.join(","))
    }
}

/// One audio source placed on the export timeline.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInput {
    /// Source media file (audio file, or a video that has an audio stream).
    pub path: String,

    /// Seconds into the export where this audio starts.
    pub start_time: f64,

    /// Seconds into the source file where playback begins (trim in).
    pub trim_in: f64,

    /// Seconds this audio lasts ON THE EXPORT TIMELINE (after any speed change).
    pub duration: f64,

    /// Playback speed (1.0 = normal, 2.0 = twice as fast). The source span used is
    /// `duration * speed`; the pitch of the voice is kept.
    #[serde(default = "default_speed")]
    pub speed: f64,

    /// Linear gain (1.0 = unchanged).
    #[serde(default = "default_volume")]
    pub volume: f64,

    /// Linear fade-in length in seconds.
    #[serde(default)]
    pub fade_in: f64,

    /// Linear fade-out length in seconds.
    #[serde(default)]
    pub fade_out: f64,

    /// Channel count of the source's first audio stream. Filled in by the
    /// ffprobe check (not sent by the frontend); 0 = unknown, treated as non-mono.
    #[serde(skip)]
    pub channels: u32,
}

/// Active export session.
struct ExportSession {
    /// FFmpeg child process
    process: Child,
    
    /// Stdin handle for writing frames
    stdin: tokio::process::ChildStdin,
    
    /// Current frame count
    current_frame: u32,
    
    /// Total frames
    total_frames: u32,
    
    /// Start time
    start_time: std::time::Instant,

    /// File being written, so a cancelled/failed export can delete its partial output.
    output_path: String,
}

/// Global export sessions (keyed by session ID).
static EXPORT_SESSIONS: once_cell::sync::Lazy<Arc<Mutex<HashMap<String, ExportSession>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Whether `path` looks like a genuine native executable rather than a script
/// wearing an `.exe` extension. Checks for the "MZ" DOS-header magic bytes
/// that every real PE binary starts with. Windows' `CreateProcess` (what
/// `Command::new` uses) refuses to launch a non-PE file even if it has an
/// `.exe` extension, unlike a shell, which may dispatch by content.
fn looks_like_real_exe(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut magic = [0u8; 2];
    file.read_exact(&mut magic).is_ok() && &magic == b"MZ"
}

/// Resolve `ffmpeg`'s absolute path by walking PATH ourselves.
///
/// On some Windows setups, `Command::new("ffmpeg")` (bare name, relying on the
/// OS to search PATH) fails with a spurious "not compatible with the version
/// of Windows" error (os error 216) even though the same executable runs fine
/// via its absolute path or from a regular shell. Resolving the path ourselves
/// and invoking that directly sidesteps it. Falls back to the bare name if not
/// found, so behavior is unchanged on systems where this doesn't happen.
///
/// Also skips PATH entries that resolve to a non-PE file with an `.exe`
/// extension (e.g. `src-tauri/target/debug/ffmpeg.exe`, which Tauri's dev
/// sidecar setup places on PATH as a plain batch-script dev stub) and keeps
/// searching, since Windows can't actually execute those via CreateProcess.
pub fn resolve_ffmpeg_path(exe_name: &str) -> String {
    let candidate = if cfg!(windows) { format!("{}.exe", exe_name) } else { exe_name.to_string() };

    // 1. A copy bundled next to the app (the installer ships ffmpeg/ffprobe there).
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        if let Some(found) = find_executable_in(std::slice::from_ref(&dir), &candidate) {
            return found;
        }
    }

    // 2. Anything on PATH.
    if let Ok(path_var) = std::env::var("PATH") {
        let dirs: Vec<std::path::PathBuf> = path_var.split(if cfg!(windows) { ';' } else { ':' }).filter(|d| !d.is_empty()).map(std::path::PathBuf::from).collect();
        if let Some(found) = find_executable_in(&dirs, &candidate) {
            return found;
        }
    }
    exe_name.to_string()
}

/// First directory in `dirs` holding a real executable called `candidate` (on Windows the file
/// must start with the "MZ" header, which skips batch-file stubs named `.exe`).
fn find_executable_in(dirs: &[std::path::PathBuf], candidate: &str) -> Option<String> {
    dirs.iter().map(|d| d.join(candidate)).find(|p| p.is_file() && (!cfg!(windows) || looks_like_real_exe(p))).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("clypra-resolve-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_a_real_executable_and_skips_stubs() {
        let stub_dir = temp_dir("stub");
        let real_dir = temp_dir("real");
        std::fs::write(stub_dir.join("tool.exe"), b"@echo off\r\nexit 1\r\n").unwrap(); // batch text, no MZ
        std::fs::write(real_dir.join("tool.exe"), b"MZ\x90\x00fake pe").unwrap();

        let found = find_executable_in(&[stub_dir.clone(), real_dir.clone()], "tool.exe");
        if cfg!(windows) {
            assert_eq!(found.as_deref(), Some(real_dir.join("tool.exe").to_string_lossy().as_ref()));
        } else {
            assert!(found.is_some());
        }
        assert!(find_executable_in(&[stub_dir.clone()], "missing.exe").is_none());
        let _ = std::fs::remove_dir_all(&stub_dir);
        let _ = std::fs::remove_dir_all(&real_dir);
    }

    #[test]
    fn earlier_directories_win() {
        let first = temp_dir("first");
        let second = temp_dir("second");
        std::fs::write(first.join("tool.exe"), b"MZ-first").unwrap();
        std::fs::write(second.join("tool.exe"), b"MZ-second").unwrap();
        let found = find_executable_in(&[first.clone(), second.clone()], "tool.exe").unwrap();
        assert!(found.starts_with(first.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(&first);
        let _ = std::fs::remove_dir_all(&second);
    }
}

/// Channel count of `path`'s first audio stream via ffprobe, or `None` when the
/// file has no audio. Video clips without sound (screen captures, muted
/// exports…) must not reach the mixer, or ffmpeg fails with "Stream specifier
/// ':a' matches no streams".
async fn probe_audio_channels(path: &str) -> Option<u32> {
    let out = tokio_command(resolve_ffmpeg_path("ffprobe"))
        .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", path])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().lines().next()?.trim().parse::<u32>().ok()
}

/// Builds the `-filter_complex` graph that trims, positions, gains and fades
/// each audio input, then mixes them into one stream.
///
/// `first_index` is the ffmpeg input index of the first audio file (input 0 is
/// the PNG frame pipe). Returns `(graph, output_label)`, or `None` when there
/// is nothing audible. Every source is normalised to 48 kHz stereo first so
/// mono/5.1 files mix cleanly, and the mix is soft-limited (`level=0` keeps
/// alimiter from auto-boosting quiet mixes) to avoid hard clipping when voice
/// and music add up.
pub fn build_audio_filter(inputs: &[AudioInput], first_index: usize) -> Option<(String, String)> {
    let usable: Vec<&AudioInput> = inputs.iter().filter(|a| a.duration > 0.01).collect();
    if usable.is_empty() {
        return None;
    }

    let mut chains: Vec<String> = Vec::new();
    for (i, a) in usable.iter().enumerate() {
        let k = first_index + i;
        let dur = a.duration;
        let vol = a.volume.clamp(0.0, 4.0);
        let fade_in = a.fade_in.clamp(0.0, dur);
        let fade_out = a.fade_out.clamp(0.0, dur);
        let delay_ms = (a.start_time.max(0.0) * 1000.0).round() as u64;

        // Mono -> stereo via aformat attenuates by 3 dB (center-mix downscale),
        // which would leave voice-overs (usually mono) quieter than in preview.
        // Duplicating the channel keeps the level exact.
        let to_stereo = if a.channels == 1 {
            "aresample=48000,pan=stereo|c0=c0|c1=c0"
        } else {
            "aformat=sample_rates=48000:channel_layouts=stereo"
        };
        let speed = a.speed.clamp(0.25, 8.0);
        let mut chain = format!(
            "[{k}:a]{},atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS{},volume={:.4}",
            to_stereo,
            a.trim_in.max(0.0),
            dur * speed,
            atempo_chain(speed),
            vol
        );
        if fade_in > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={:.3}", fade_in));
        }
        if fade_out > 0.0 {
            chain.push_str(&format!(",afade=t=out:st={:.3}:d={:.3}", dur - fade_out, fade_out));
        }
        chain.push_str(&format!(",adelay=delays={}:all=1[a{}]", delay_ms, i));
        chains.push(chain);
    }

    // The limiter runs on every export, also with a single source: a lone voice-over boosted
    // above 100 % would otherwise reach the AAC encoder unlimited and clip.
    if usable.len() == 1 {
        chains.push("[a0]alimiter=limit=0.89:level=0[aout]".to_string());
        return Some((chains.join(";"), "aout".to_string()));
    }

    let labels: String = (0..usable.len()).map(|i| format!("[a{}]", i)).collect();
    chains.push(format!(
        "{}amix=inputs={}:duration=longest:normalize=0[mix]",
        labels,
        usable.len()
    ));
    chains.push("[mix]alimiter=limit=0.89:level=0[aout]".to_string());
    Some((chains.join(";"), "aout".to_string()))
}

/// Hardware H.264 encoders, in order of preference.
const HARDWARE_H264_ENCODERS: [&str; 3] = ["h264_nvenc", "h264_qsv", "h264_amf"];

static HARDWARE_H264: tokio::sync::OnceCell<Option<&'static str>> = tokio::sync::OnceCell::const_new();

/// Encodes a tiny synthetic clip with `encoder`; ffmpeg lists encoders it was *built* with,
/// but only the ones the machine's GPU/driver supports actually succeed here.
async fn encoder_works(ffmpeg: &str, encoder: &str) -> bool {
    let probe = tokio_command(ffmpeg)
        .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=0.2", "-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "null", "-"])
        .stdin(Stdio::null())
        .output();
    matches!(tokio::time::timeout(std::time::Duration::from_secs(10), probe).await, Ok(Ok(out)) if out.status.success())
}

/// First hardware H.264 encoder that really works on this machine (probed once, cached).
pub async fn detect_hardware_h264(ffmpeg: &str) -> Option<&'static str> {
    *HARDWARE_H264
        .get_or_init(|| async {
            for enc in HARDWARE_H264_ENCODERS {
                if encoder_works(ffmpeg, enc).await {
                    eprintln!("[export] hardware H.264 encoder available: {}", enc);
                    return Some(enc);
                }
            }
            eprintln!("[export] no hardware H.264 encoder available, using libx264");
            None
        })
        .await
}

/// Codec arguments for a hardware H.264 encoder, mapping our preset/CRF to its own scale.
fn hardware_h264_args(encoder: &str, preset: &str, crf: u32) -> Vec<String> {
    let q = crf.to_string();
    match encoder {
        "h264_nvenc" => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", &q, "-b:v", "0"],
        "h264_qsv" => {
            // Quick Sync has no "ultrafast"; ICQ (-global_quality) is its CRF equivalent.
            let p = if preset == "ultrafast" { "veryfast" } else { preset };
            vec!["-c:v", "h264_qsv", "-preset", p, "-global_quality", &q, "-look_ahead", "0"]
        }
        _ => vec!["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q],
    }
    .into_iter()
    .map(String::from)
    .collect()
}

/// Start a video export session.
///
/// Returns a session ID that can be used to write frames and finalize.
#[tauri::command]
pub async fn start_video_export(config: ExportConfig) -> Result<String, String> {
    // Generate session ID
    let session_id = uuid::Uuid::new_v4().to_string();
    
    // Build FFmpeg command
    let mut cmd = tokio_command(resolve_ffmpeg_path("ffmpeg"));

    // stderr is piped but only drained at finalize; ffmpeg's periodic progress
    // stats would eventually fill the pipe buffer and stall long exports.
    cmd.arg("-hide_banner").arg("-loglevel").arg("warning").arg("-nostats");

    // Keep only audio sources that actually have an audio stream.
    let mut audio_inputs: Vec<AudioInput> = Vec::new();
    for a in &config.audio_inputs {
        let channels = if a.duration > 0.01 { probe_audio_channels(&a.path).await } else { None };
        match channels {
            Some(ch) => {
                let mut input = a.clone();
                input.channels = ch;
                audio_inputs.push(input);
            }
            None => eprintln!("[start_video_export] Skipping audio source (no audio stream or empty): {}", a.path),
        }
    }

    // Input: a stream of PNG-encoded frames from stdin. Frames are encoded to
    // PNG in the frontend before being sent over IPC — raw RGBA (~8MB/frame at
    // 1080p) made the JS->Rust invoke bridge (which JSON-encodes args) the
    // dominant export bottleneck; PNG shrinks that payload by ~15-20x.
    if config.frame_format.as_deref() == Some("rgba") {
        cmd.arg("-f")
            .arg("rawvideo")
            .arg("-pix_fmt")
            .arg("rgba")
            .arg("-s")
            .arg(format!("{}x{}", config.width, config.height))
            .arg("-framerate")
            .arg(config.frame_rate.to_string())
            .arg("-i")
            .arg("pipe:0");
    } else {
        cmd.arg("-f")
            .arg("image2pipe")
            .arg("-vcodec")
            .arg("png")
            .arg("-framerate")
            .arg(config.frame_rate.to_string())
            .arg("-i")
            .arg("pipe:0");
    }

    // Audio files follow the frame pipe as inputs 1..N (kept in the same
    // order build_audio_filter indexes them).
    for a in &audio_inputs {
        cmd.arg("-i").arg(&a.path);
    }
    
    // Video codec settings
    match config.codec.as_str() {
        "h264" => {
            let want_hardware = config.encoder.as_deref() == Some("auto") && config.pixel_format == "yuv420p";
            let hardware = if want_hardware { detect_hardware_h264(&resolve_ffmpeg_path("ffmpeg")).await } else { None };
            match hardware {
                Some(enc) => {
                    cmd.args(hardware_h264_args(enc, &config.preset, config.crf));
                    eprintln!("[start_video_export] encoder: {}", enc);
                }
                None => {
                    cmd.arg("-c:v").arg("libx264");
                    cmd.arg("-preset").arg(&config.preset);
                    cmd.arg("-crf").arg(config.crf.to_string());
                    eprintln!("[start_video_export] encoder: libx264");
                }
            }
            cmd.arg("-pix_fmt").arg(&config.pixel_format);
        }
        "h265" => {
            cmd.arg("-c:v").arg("libx265");
            cmd.arg("-preset").arg(&config.preset);
            cmd.arg("-crf").arg(config.crf.to_string());
            cmd.arg("-pix_fmt").arg(&config.pixel_format);
        }
        "prores" => {
            cmd.arg("-c:v").arg("prores_ks");
            cmd.arg("-profile:v").arg("3"); // ProRes 422 HQ
            cmd.arg("-pix_fmt").arg("yuv422p10le");
        }
        _ => {
            return Err(format!("Unsupported codec: {}", config.codec));
        }
    }
    
    // Audio mix: voice-over + music + video audio, trimmed/delayed/gained per clip.
    if let Some((graph, label)) = build_audio_filter(&audio_inputs, 1) {
        cmd.arg("-filter_complex").arg(graph);
        cmd.arg("-map").arg("0:v");
        cmd.arg("-map").arg(format!("[{}]", label));
        if config.codec == "prores" {
            cmd.arg("-c:a").arg("pcm_s16le");
        } else {
            cmd.arg("-c:a").arg("aac").arg("-b:a").arg("192k");
        }
        cmd.arg("-ar").arg("48000");
        // Audio can outlast the picture; the export length is the frame count.
        cmd.arg("-t").arg(format!("{:.3}", config.total_frames as f64 / config.frame_rate));
    }

    // Output settings
    cmd.arg("-movflags").arg("+faststart"); // Enable streaming
    cmd.arg("-y"); // Overwrite output file
    cmd.arg(&config.output_path);
    
    // Spawn FFmpeg process
    // kill_on_drop: if a session is ever dropped without finalize/cancel (crash, window closed),
    // the FFmpeg child dies with it instead of lingering as an orphan.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn FFmpeg: {}", e))?;
    
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open stdin".to_string())?;
    
    // Create session
    let session = ExportSession {
        process: child,
        stdin,
        current_frame: 0,
        total_frames: config.total_frames,
        start_time: std::time::Instant::now(),
        output_path: config.output_path.clone(),
    };
    
    // Store session
    EXPORT_SESSIONS.lock().await.insert(session_id.clone(), session);
    
    eprintln!(
        "[start_video_export] Started session {} ({}x{} @ {}fps, {} frames, codec={})",
        session_id, config.width, config.height, config.frame_rate, config.total_frames, config.codec
    );
    
    Ok(session_id)
}

/// Last few non-empty lines of FFmpeg's stderr, for error messages a user can act on.
fn stderr_tail(stderr: &[u8], lines: usize) -> String {
    let text = String::from_utf8_lossy(stderr);
    let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = tail.len().saturating_sub(lines);
    tail[start..].join(" | ")
}

fn remove_partial_output(path: &str) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[export] could not remove partial output {}: {}", path, e);
        }
    }
}

/// Ends a session that failed: kills FFmpeg, reaps it, deletes the partial file and returns
/// FFmpeg's last stderr lines so the UI can show what went wrong.
async fn abort_session(mut session: ExportSession, reason: &str) -> String {
    drop(session.stdin);
    let _ = session.process.kill().await;
    let stderr = match tokio::time::timeout(std::time::Duration::from_secs(3), session.process.wait_with_output()).await {
        Ok(Ok(out)) => stderr_tail(&out.stderr, 3),
        _ => String::new(),
    };
    remove_partial_output(&session.output_path);
    if stderr.is_empty() {
        reason.to_string()
    } else {
        format!("{} ({})", reason, stderr)
    }
}

/// Writes one frame (PNG bytes, or raw RGBA when `frame_format` is "rgba") to a session's FFmpeg.
pub async fn write_frame_bytes(session_id: &str, frame_data: &[u8]) -> Result<ExportProgress, String> {
    let mut sessions = EXPORT_SESSIONS.lock().await;

    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;

    if let Err(e) = session.stdin.write_all(frame_data).await {
        // FFmpeg exited early (bad arguments, disk full, encoder failure...): finish the session cleanly.
        let session = sessions.remove(session_id).expect("session present");
        drop(sessions);
        let msg = abort_session(session, &format!("FFmpeg stopped while exporting: {}", e)).await;
        return Err(msg);
    }

    session.current_frame += 1;

    let progress = session.current_frame as f64 / session.total_frames as f64;
    let elapsed = session.start_time.elapsed().as_secs_f64();
    let fps = session.current_frame as f64 / elapsed;
    let remaining_frames = session.total_frames.saturating_sub(session.current_frame);
    let eta_seconds = if fps > 0.0 { remaining_frames as f64 / fps } else { 0.0 };

    let progress_update = ExportProgress {
        current_frame: session.current_frame,
        total_frames: session.total_frames,
        progress,
        eta_seconds,
        fps,
    };

    if session.current_frame % 30 == 0 || session.current_frame == session.total_frames {
        eprintln!(
            "[write_export_frame] Session {}: {}/{} frames ({:.1}%) @ {:.1} fps, ETA {:.1}s",
            session_id,
            session.current_frame,
            session.total_frames,
            progress * 100.0,
            fps,
            eta_seconds
        );
    }

    Ok(progress_update)
}

/// Write a frame to the export session. The frame travels as the raw request body (binary IPC)
/// and the session id in the `x-session-id` header; taking it as a `Vec<u8>` argument made Tauri
/// JSON-encode ~1MB per frame as a number array, which cost ~600ms/frame.
#[tauri::command]
pub async fn write_export_frame(request: tauri::ipc::Request<'_>) -> Result<ExportProgress, String> {
    let tauri::ipc::InvokeBody::Raw(frame_data) = request.body() else {
        return Err("Expected raw binary frame data".to_string());
    };
    let session_id = request
        .headers()
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing x-session-id header")?
        .to_string();
    write_frame_bytes(&session_id, frame_data).await
}

/// Finalize the export session: close stdin and wait for FFmpeg to finish encoding.
#[tauri::command]
pub async fn finalize_video_export(session_id: String) -> Result<(), String> {
    let session = EXPORT_SESSIONS
        .lock()
        .await
        .remove(&session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;

    let ExportSession { process, stdin, current_frame, start_time, output_path, .. } = session;

    // Closing stdin signals end of input.
    drop(stdin);

    let output = process
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;

    let elapsed = start_time.elapsed();

    if output.status.success() {
        eprintln!(
            "[finalize_video_export] Session {} completed successfully in {:.2}s ({} frames)",
            session_id,
            elapsed.as_secs_f64(),
            current_frame
        );
        Ok(())
    } else {
        eprintln!("[finalize_video_export] Session {} failed:\n{}", session_id, String::from_utf8_lossy(&output.stderr));
        remove_partial_output(&output_path);
        Err(format!("FFmpeg failed: {}", stderr_tail(&output.stderr, 3)))
    }
}

/// Cancel an export session: kills FFmpeg, waits for it to exit and deletes the partial file.
#[tauri::command]
pub async fn cancel_video_export(session_id: String) -> Result<(), String> {
    let mut session = EXPORT_SESSIONS
        .lock()
        .await
        .remove(&session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;

    drop(session.stdin);
    session
        .process
        .kill()
        .await
        .map_err(|e| format!("Failed to kill FFmpeg: {}", e))?;
    let _ = session.process.wait().await; // reap it so no zombie/handle is left behind
    remove_partial_output(&session.output_path);

    eprintln!(
        "[cancel_video_export] Session {} cancelled ({} frames written), partial file removed",
        session_id, session.current_frame
    );

    Ok(())
}

/// Kills every in-flight export (used when the app window closes mid-export).
pub async fn cancel_all_exports() {
    let sessions: Vec<(String, ExportSession)> = EXPORT_SESSIONS.lock().await.drain().collect();
    for (id, mut session) in sessions {
        drop(session.stdin);
        let _ = session.process.kill().await;
        let _ = session.process.wait().await;
        remove_partial_output(&session.output_path);
        eprintln!("[cancel_all_exports] Session {} killed on shutdown", id);
    }
}

/// Check if FFmpeg is available on the system.
#[tauri::command]
pub async fn check_ffmpeg_available() -> Result<bool, String> {
    let output = tokio_command(resolve_ffmpeg_path("ffmpeg"))
        .arg("-version")
        .output()
        .await;

    match output {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

/// Get FFmpeg version information.
#[tauri::command]
pub async fn get_ffmpeg_version() -> Result<String, String> {
    let output = tokio_command(resolve_ffmpeg_path("ffmpeg"))
        .arg("-version")
        .output()
        .await
        .map_err(|e| format!("Failed to run FFmpeg: {}", e))?;
    
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        let first_line = version.lines().next().unwrap_or("Unknown");
        Ok(first_line.to_string())
    } else {
        Err("FFmpeg not available".to_string())
    }
}

#[cfg(test)]
mod audio_filter_tests {
    use super::*;

    fn input(start: f64, trim: f64, dur: f64) -> AudioInput {
        AudioInput { path: "x.wav".into(), start_time: start, trim_in: trim, duration: dur, speed: 1.0, volume: 1.0, fade_in: 0.0, fade_out: 0.0, channels: 2 }
    }

    #[test]
    fn atempo_chain_keeps_every_stage_inside_ffmpegs_range() {
        assert_eq!(atempo_chain(1.0), "");
        assert_eq!(atempo_chain(1.5), ",atempo=1.500000");
        assert_eq!(atempo_chain(2.0), ",atempo=2.000000");
        assert_eq!(atempo_chain(4.0), ",atempo=2.000000,atempo=2.000000");
        assert_eq!(atempo_chain(0.5), ",atempo=0.500000");
        assert_eq!(atempo_chain(0.25), ",atempo=0.500000,atempo=0.500000");
        assert_eq!(atempo_chain(3.0), ",atempo=2.000000,atempo=1.500000");
        // out-of-range requests are clamped to 0.25x..8x
        assert_eq!(atempo_chain(100.0), ",atempo=2.000000,atempo=2.000000,atempo=2.000000");
    }

    #[test]
    fn speed_reads_more_source_than_the_clip_lasts_on_the_timeline() {
        // 10 s on the timeline at 1.5x consumes 15 s of source, then atempo squeezes it back to 10 s.
        let mut a = input(0.0, 2.0, 10.0);
        a.speed = 1.5;
        a.fade_out = 1.0;
        let (graph, _) = build_audio_filter(&[a], 1).unwrap();
        assert!(graph.contains("atrim=start=2.000:duration=15.000,asetpts=PTS-STARTPTS,atempo=1.500000,volume=1.0000"), "{}", graph);
        // fades are timeline-based: they come after the speed change and use the timeline duration
        assert!(graph.contains("afade=t=out:st=9.000:d=1.000"), "{}", graph);
    }

    #[test]
    fn no_inputs_means_no_audio() {
        assert!(build_audio_filter(&[], 1).is_none());
        // zero/near-zero length clips are dropped
        assert!(build_audio_filter(&[input(0.0, 0.0, 0.0)], 1).is_none());
    }

    #[test]
    fn single_input_trims_delays_and_skips_mixer() {
        let (graph, label) = build_audio_filter(&[input(2.5, 1.0, 4.0)], 1).unwrap();
        assert_eq!(label, "aout");
        assert!(graph.ends_with("[a0]alimiter=limit=0.89:level=0[aout]"), "a single source is still limited: {}", graph);
        assert!(graph.starts_with("[1:a]aformat=sample_rates=48000:channel_layouts=stereo,"));
        assert!(graph.contains("atrim=start=1.000:duration=4.000"));
        assert!(graph.contains("adelay=delays=2500:all=1[a0]"));
        assert!(!graph.contains("amix"));
        assert!(!graph.contains("afade"));
    }

    #[test]
    fn volume_and_fades_are_applied_and_clamped() {
        let mut a = input(0.0, 0.0, 4.0);
        a.volume = 0.5;
        a.fade_in = 1.0;
        a.fade_out = 99.0; // longer than the clip -> clamped to its duration
        let (graph, _) = build_audio_filter(&[a], 1).unwrap();
        assert!(graph.contains("volume=0.5000"));
        assert!(graph.contains("afade=t=in:st=0:d=1.000"));
        assert!(graph.contains("afade=t=out:st=0.000:d=4.000"));
    }

    #[test]
    fn multiple_inputs_are_mixed_and_limited_with_correct_indexes() {
        let (graph, label) = build_audio_filter(&[input(0.0, 0.0, 5.0), input(1.0, 0.0, 3.0)], 1).unwrap();
        assert_eq!(label, "aout");
        assert!(graph.contains("[1:a]"));
        assert!(graph.contains("[2:a]"));
        assert!(graph.contains("[a0][a1]amix=inputs=2:duration=longest:normalize=0[mix]"));
        assert!(graph.contains("[mix]alimiter=limit=0.89:level=0[aout]"));
    }

    #[test]
    fn mono_sources_duplicate_the_channel_instead_of_aformat() {
        let mut a = input(0.0, 0.0, 3.0);
        a.channels = 1;
        let (graph, _) = build_audio_filter(&[a], 1).unwrap();
        assert!(graph.contains("pan=stereo|c0=c0|c1=c0"));
        assert!(!graph.contains("aformat"));
    }

    #[test]
    fn skipped_inputs_do_not_shift_input_indexes() {
        // build_audio_filter indexes by position among *usable* inputs, matching
        // how start_video_export adds `-i` only for the ones that survive.
        let (graph, _) = build_audio_filter(&[input(0.0, 0.0, 0.0), input(0.0, 0.0, 2.0)], 1).unwrap();
        assert!(graph.starts_with("[1:a]"));
    }
}

/// End-to-end checks of the real export pipeline (FFmpeg required; each test is skipped with a
/// message when FFmpeg/FFprobe are not installed). They drive the same functions the app uses:
/// start_video_export -> write_frame_bytes -> finalize/cancel, then inspect the file with ffprobe.
#[cfg(test)]
mod export_pipeline_tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;

    const FPS: f64 = 30.0;
    const SECONDS: u32 = 3;
    const SIZE: u32 = 128;

    fn tool_available(name: &str) -> bool {
        StdCommand::new(resolve_ffmpeg_path(name)).arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn tools_available() -> bool {
        let ok = tool_available("ffmpeg") && tool_available("ffprobe");
        if !ok {
            eprintln!("SKIPPED: ffmpeg/ffprobe not found on PATH");
        }
        ok
    }

    fn work_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clypra-export-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 440 Hz or 880 Hz stereo sine, `seconds` long.
    fn make_sine(path: &PathBuf, hz: u32, seconds: u32) {
        let status = StdCommand::new(resolve_ffmpeg_path("ffmpeg"))
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("sine=frequency={}:duration={}", hz, seconds))
            // lavfi sines peak at 0.125; x8 brings each to full scale so the 2-source mix WOULD clip
            // (1.0 + 0.5 voice) unless the limiter works.
            .args(["-af", "volume=8", "-ac", "2", "-ar", "48000"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "could not synthesise test audio");
    }

    fn png_frame(index: u32) -> Vec<u8> {
        use image::ImageEncoder;
        let shade = (index % 200) as u8;
        let img = image::RgbImage::from_pixel(SIZE, SIZE, image::Rgb([shade, 255 - shade, 90]));
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out).write_image(img.as_raw(), SIZE, SIZE, image::ExtendedColorType::Rgb8).unwrap();
        out
    }

    fn audio(path: &PathBuf, volume: f64, fade_out: f64) -> AudioInput {
        AudioInput { path: path.to_string_lossy().to_string(), start_time: 0.0, trim_in: 0.0, duration: SECONDS as f64, speed: 1.0, volume, fade_in: 0.0, fade_out, channels: 2 }
    }

    fn config(output: &PathBuf, audio_inputs: Vec<AudioInput>) -> ExportConfig {
        ExportConfig {
            output_path: output.to_string_lossy().to_string(),
            width: SIZE,
            height: SIZE,
            frame_rate: FPS,
            total_frames: (SECONDS as f64 * FPS) as u32,
            codec: "h264".into(),
            preset: "ultrafast".into(),
            crf: 28,
            pixel_format: "yuv420p".into(),
            encoder: Some("software".into()),
            frame_format: None,
            audio_inputs,
        }
    }

    /// (codec_type, duration seconds) for every stream.
    fn stream_durations(path: &PathBuf) -> Vec<(String, f64)> {
        let out = StdCommand::new(resolve_ffmpeg_path("ffprobe"))
            .args(["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut parts = l.trim().split(',');
                let kind = parts.next()?.to_string();
                let dur = parts.next()?.parse::<f64>().ok()?;
                Some((kind, dur))
            })
            .collect()
    }

    /// Peak and mean level of the audio in dBFS, via ffmpeg's volumedetect.
    fn audio_levels(path: &PathBuf) -> (f64, f64) {
        let out = StdCommand::new(resolve_ffmpeg_path("ffmpeg"))
            .args(["-hide_banner", "-i"])
            .arg(path)
            .args(["-af", "volumedetect", "-vn", "-f", "null", "-"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stderr).to_string();
        let grab = |key: &str| -> f64 {
            let line = text.lines().find(|l| l.contains(key)).unwrap_or_else(|| panic!("no {} in: {}", key, text));
            line.split(key).nth(1).unwrap().trim().trim_end_matches(" dB").trim().parse().unwrap()
        };
        (grab("max_volume:"), grab("mean_volume:"))
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn exported_mp4_has_audio_matching_video_duration_and_no_clipping() {
        if !tools_available() {
            return;
        }
        let dir = work_dir("audio");
        let voice = dir.join("voice.wav");
        let music = dir.join("music.wav");
        make_sine(&voice, 440, SECONDS);
        make_sine(&music, 880, SECONDS);
        let output = dir.join("out.mp4");

        // Voice at half volume with a 1 s fade-out + music at full volume: a real mix.
        let cfg = config(&output, vec![audio(&voice, 0.5, 1.0), audio(&music, 1.0, 0.0)]);

        run(async {
            let id = start_video_export(cfg).await.expect("start export");
            for i in 0..(SECONDS * FPS as u32) {
                write_frame_bytes(&id, &png_frame(i)).await.expect("write frame");
            }
            finalize_video_export(id).await.expect("finalize export");
        });

        let streams = stream_durations(&output);
        let video = streams.iter().find(|(k, _)| k == "video").expect("video stream present").1;
        let audio_dur = streams.iter().find(|(k, _)| k == "audio").expect("audio stream present").1;
        assert!((video - SECONDS as f64).abs() < 0.1, "video duration {} should be ~{}", video, SECONDS);
        assert!((audio_dur - video).abs() < 0.15, "audio ({}) and video ({}) durations must match", audio_dur, video);

        let (peak, mean) = audio_levels(&output);
        eprintln!("[export test] video {:.3}s, audio {:.3}s, peak {:.2} dBFS, mean {:.2} dBFS", video, audio_dur, peak, mean);
        assert!(peak < -0.05, "audio clips: peak {} dBFS", peak);
        assert!(peak > -6.0, "limiter should leave the mix near full scale, not crush it: peak {} dBFS", peak);
        assert!(mean > -45.0, "audio is (nearly) silent: mean {} dBFS", mean);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Plain 440 Hz sine at lavfi's default level (peaks around -18 dBFS): quiet on purpose.
    fn make_quiet_sine(path: &PathBuf) {
        let status = StdCommand::new(resolve_ffmpeg_path("ffmpeg"))
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={}", SECONDS))
            .args(["-ac", "2", "-ar", "48000"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn export_with_volume(dir: &PathBuf, source: &PathBuf, name: &str, volume: f64) -> PathBuf {
        let output = dir.join(name);
        let cfg = config(&output, vec![audio(source, volume, 0.0)]);
        run(async {
            let id = start_video_export(cfg).await.expect("start export");
            for i in 0..(SECONDS * FPS as u32) {
                write_frame_bytes(&id, &png_frame(i)).await.expect("write frame");
            }
            finalize_video_export(id).await.expect("finalize export");
        });
        output
    }

    #[test]
    fn volume_above_100_percent_boosts_the_export_and_the_limiter_still_prevents_clipping() {
        if !tools_available() {
            return;
        }
        let dir = work_dir("boost");
        let quiet = dir.join("quiet.wav");
        make_quiet_sine(&quiet);

        let (peak_unity, _) = audio_levels(&export_with_volume(&dir, &quiet, "v100.mp4", 1.0));
        let (peak_boost, _) = audio_levels(&export_with_volume(&dir, &quiet, "v300.mp4", 3.0));
        // 300 % is +9.54 dB. Allow for AAC rounding.
        let gained = peak_boost - peak_unity;
        eprintln!("[export test] peak at 100%: {:.2} dBFS, at 300%: {:.2} dBFS (gain {:.2} dB)", peak_unity, peak_boost, gained);
        assert!((gained - 9.54).abs() < 1.5, "300% should be ~9.5 dB louder than 100%, was {:.2} dB", gained);

        // A source already at full scale pushed to the maximum (400 %) must still not clip.
        let loud = dir.join("loud.wav");
        make_sine(&loud, 440, SECONDS);
        let (peak_max, _) = audio_levels(&export_with_volume(&dir, &loud, "v400.mp4", 4.0));
        assert!(peak_max < -0.05, "400% of a full-scale source must be limited, peak {:.2} dBFS", peak_max);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_without_audio_inputs_has_no_audio_stream() {
        if !tools_available() {
            return;
        }
        let dir = work_dir("silent");
        let output = dir.join("out.mp4");
        run(async {
            let id = start_video_export(config(&output, vec![])).await.expect("start export");
            for i in 0..(SECONDS * FPS as u32) {
                write_frame_bytes(&id, &png_frame(i)).await.expect("write frame");
            }
            finalize_video_export(id).await.expect("finalize export");
        });
        let streams = stream_durations(&output);
        assert!(streams.iter().any(|(k, _)| k == "video"));
        assert!(!streams.iter().any(|(k, _)| k == "audio"), "no audio expected: {:?}", streams);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_removes_the_partial_file_and_the_session() {
        if !tools_available() {
            return;
        }
        let dir = work_dir("cancel");
        let output = dir.join("partial.mp4");
        run(async {
            let id = start_video_export(config(&output, vec![])).await.expect("start export");
            for i in 0..20 {
                write_frame_bytes(&id, &png_frame(i)).await.expect("write frame");
            }
            cancel_video_export(id.clone()).await.expect("cancel export");
            assert!(cancel_video_export(id.clone()).await.is_err(), "session must be gone after cancel");
            assert!(write_frame_bytes(&id, &png_frame(0)).await.is_err(), "no writes after cancel");
        });
        assert!(!output.exists(), "partial output file must be deleted on cancel");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ffmpeg_failure_is_reported_clearly_and_leaves_no_file() {
        if !tools_available() {
            return;
        }
        let dir = work_dir("fail");
        // The output directory does not exist, so FFmpeg exits right away.
        let output = dir.join("missing-dir").join("out.mp4");
        let result = run(async {
            let id = start_video_export(config(&output, vec![])).await.expect("start export");
            let mut last = Ok(());
            for i in 0..200 {
                if let Err(e) = write_frame_bytes(&id, &png_frame(i)).await {
                    last = Err(e);
                    break;
                }
            }
            if last.is_ok() {
                last = finalize_video_export(id).await;
            }
            last
        });
        let err = result.expect_err("a failing FFmpeg must surface as an error");
        assert!(err.to_lowercase().contains("ffmpeg"), "error should mention FFmpeg: {}", err);
        assert!(!output.exists(), "no output file should remain");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ─── Export folders: one folder per export, named after the project ────────────────────────────

/// Windows device names that cannot be used as file/folder names.
const RESERVED_NAMES: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

/// Turns a project name into something every filesystem accepts.
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    // Windows silently drops trailing dots/spaces, which would make two names collide.
    let trimmed = cleaned.trim().trim_end_matches(|c| c == '.' || c == ' ').to_string();
    let limited: String = trimmed.chars().take(80).collect();
    let limited = limited.trim_end().to_string();
    if limited.is_empty() {
        return "Export".to_string();
    }
    let stem_upper = limited.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED_NAMES.contains(&stem_upper.as_str()) {
        return format!("{}_", limited);
    }
    limited
}

/// `Name`, then `Name (copia 1)`, `Name (copia 2)`... — the first one that does not exist in `base`.
pub fn unique_folder_name(base: &std::path::Path, name: &str) -> String {
    let clean = sanitize_file_name(name);
    if !base.join(&clean).exists() {
        return clean;
    }
    let mut n = 1u32;
    loop {
        let candidate = format!("{} (copia {})", clean, n);
        if !base.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFolder {
    /// Absolute folder path.
    pub folder: String,
    /// Folder name; the video and its cover inside use it as their file name.
    pub stem: String,
}

fn require_dir(base_dir: &str) -> Result<std::path::PathBuf, String> {
    let base = std::path::PathBuf::from(base_dir);
    if !base.is_dir() {
        return Err(format!("The export location does not exist: {}", base_dir));
    }
    Ok(base)
}

/// The folder an export would create now (nothing is created) — shown in the dialog.
#[tauri::command]
pub fn preview_export_folder(base_dir: String, name: String) -> Result<ExportFolder, String> {
    let base = require_dir(&base_dir)?;
    let stem = unique_folder_name(&base, &name);
    Ok(ExportFolder { folder: base.join(&stem).to_string_lossy().to_string(), stem })
}

/// Creates the export folder. `create_dir` fails when the folder already exists, so two exports
/// started together can never end up sharing (and overwriting each other in) the same folder.
#[tauri::command]
pub fn create_export_folder(base_dir: String, name: String) -> Result<ExportFolder, String> {
    let base = require_dir(&base_dir)?;
    for _ in 0..1000 {
        let stem = unique_folder_name(&base, &name);
        let folder = base.join(&stem);
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(ExportFolder { folder: folder.to_string_lossy().to_string(), stem }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create the export folder {}: {}", folder.display(), e)),
        }
    }
    Err("Could not find a free export folder name".to_string())
}

/// Removes a folder only if it is empty (used after a cancelled/failed export). Returns whether it was removed.
#[tauri::command]
pub fn remove_empty_export_folder(folder: String) -> Result<bool, String> {
    match std::fs::remove_dir(&folder) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false), // not empty, missing or in use: leave it alone
    }
}

#[cfg(test)]
mod export_folder_tests {
    use super::*;

    fn temp_base(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("clypra-folder-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sanitizes_names_for_every_filesystem() {
        assert_eq!(sanitize_file_name("Post Muzikali News"), "Post Muzikali News");
        assert_eq!(sanitize_file_name("Noticias: hoy/ayer?"), "Noticias_ hoy_ayer_");
        assert_eq!(sanitize_file_name("  nombre.  "), "nombre");
        assert_eq!(sanitize_file_name("..."), "Export");
        assert_eq!(sanitize_file_name(""), "Export");
        assert_eq!(sanitize_file_name("con"), "con_");
        assert_eq!(sanitize_file_name("NUL.txt"), "NUL.txt_");
        assert_eq!(sanitize_file_name(&"x".repeat(200)).chars().count(), 80);
        // accents and emoji survive
        assert_eq!(sanitize_file_name("Reel Fútbol ⚽"), "Reel Fútbol ⚽");
    }

    #[test]
    fn numbers_copies_so_nothing_is_overwritten() {
        let base = temp_base("unique");
        assert_eq!(unique_folder_name(&base, "Mi Video"), "Mi Video");
        std::fs::create_dir(base.join("Mi Video")).unwrap();
        assert_eq!(unique_folder_name(&base, "Mi Video"), "Mi Video (copia 1)");
        std::fs::create_dir(base.join("Mi Video (copia 1)")).unwrap();
        std::fs::create_dir(base.join("Mi Video (copia 2)")).unwrap();
        assert_eq!(unique_folder_name(&base, "Mi Video"), "Mi Video (copia 3)");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn create_export_folder_creates_each_export_in_its_own_new_folder() {
        let base = temp_base("create");
        let b = base.to_string_lossy().to_string();

        let first = create_export_folder(b.clone(), "Post News".into()).unwrap();
        let second = create_export_folder(b.clone(), "Post News".into()).unwrap();
        let third = create_export_folder(b.clone(), "Post News".into()).unwrap();

        assert_eq!(first.stem, "Post News");
        assert_eq!(second.stem, "Post News (copia 1)");
        assert_eq!(third.stem, "Post News (copia 2)");
        for f in [&first, &second, &third] {
            assert!(std::path::Path::new(&f.folder).is_dir());
        }
        // the preview never creates anything and points at the next free name
        let preview = preview_export_folder(b.clone(), "Post News".into()).unwrap();
        assert_eq!(preview.stem, "Post News (copia 3)");
        assert!(!std::path::Path::new(&preview.folder).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_a_missing_location_and_only_removes_empty_folders() {
        assert!(create_export_folder("Z:/definitely/not/here".into(), "x".into()).is_err());
        assert!(preview_export_folder("Z:/definitely/not/here".into(), "x".into()).is_err());

        let base = temp_base("remove");
        let made = create_export_folder(base.to_string_lossy().to_string(), "x".into()).unwrap();
        std::fs::write(std::path::Path::new(&made.folder).join("keep.txt"), b"data").unwrap();
        assert!(!remove_empty_export_folder(made.folder.clone()).unwrap(), "a non-empty folder must stay");
        std::fs::remove_file(std::path::Path::new(&made.folder).join("keep.txt")).unwrap();
        assert!(remove_empty_export_folder(made.folder.clone()).unwrap());
        assert!(!std::path::Path::new(&made.folder).exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
