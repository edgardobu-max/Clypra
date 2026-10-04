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

    /// Audio sources on the timeline (voice-over, music, video audio),
    /// already clipped to the export range. Empty = silent video.
    #[serde(default)]
    pub audio_inputs: Vec<AudioInput>,
}

fn default_volume() -> f64 {
    1.0
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

    /// Seconds of source audio to use.
    pub duration: f64,

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
    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(separator) {
            if dir.is_empty() {
                continue;
            }
            let full_path = std::path::Path::new(dir).join(&candidate);
            if full_path.is_file() && (!cfg!(windows) || looks_like_real_exe(&full_path)) {
                return full_path.to_string_lossy().to_string();
            }
        }
    }
    exe_name.to_string()
}

/// Channel count of `path`'s first audio stream via ffprobe, or `None` when the
/// file has no audio. Video clips without sound (screen captures, muted
/// exports…) must not reach the mixer, or ffmpeg fails with "Stream specifier
/// ':a' matches no streams".
async fn probe_audio_channels(path: &str) -> Option<u32> {
    let out = Command::new(resolve_ffmpeg_path("ffprobe"))
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
        let mut chain = format!(
            "[{k}:a]{},atrim=start={:.3}:duration={:.3},asetpts=PTS-STARTPTS,volume={:.4}",
            to_stereo,
            a.trim_in.max(0.0),
            dur,
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

    if usable.len() == 1 {
        return Some((chains.join(";"), "a0".to_string()));
    }

    let labels: String = (0..usable.len()).map(|i| format!("[a{}]", i)).collect();
    chains.push(format!(
        "{}amix=inputs={}:duration=longest:normalize=0[mix]",
        labels,
        usable.len()
    ));
    chains.push("[mix]alimiter=limit=0.97:level=0[aout]".to_string());
    Some((chains.join(";"), "aout".to_string()))
}

/// Start a video export session.
///
/// Returns a session ID that can be used to write frames and finalize.
#[tauri::command]
pub async fn start_video_export(config: ExportConfig) -> Result<String, String> {
    // Generate session ID
    let session_id = uuid::Uuid::new_v4().to_string();
    
    // Build FFmpeg command
    let mut cmd = Command::new(resolve_ffmpeg_path("ffmpeg"));

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
    cmd.arg("-f")
        .arg("image2pipe")
        .arg("-vcodec")
        .arg("png")
        .arg("-framerate")
        .arg(config.frame_rate.to_string())
        .arg("-i")
        .arg("pipe:0");

    // Audio files follow the frame pipe as inputs 1..N (kept in the same
    // order build_audio_filter indexes them).
    for a in &audio_inputs {
        cmd.arg("-i").arg(&a.path);
    }
    
    // Video codec settings
    match config.codec.as_str() {
        "h264" => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-preset").arg(&config.preset);
            cmd.arg("-crf").arg(config.crf.to_string());
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
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    
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
    };
    
    // Store session
    EXPORT_SESSIONS.lock().await.insert(session_id.clone(), session);
    
    eprintln!(
        "[start_video_export] Started session {} ({}x{} @ {}fps, {} frames, codec={})",
        session_id, config.width, config.height, config.frame_rate, config.total_frames, config.codec
    );
    
    Ok(session_id)
}

/// Write a frame to the export session.
///
/// Frame data should be raw RGBA bytes (width * height * 4).
#[tauri::command]
pub async fn write_export_frame(request: tauri::ipc::Request<'_>) -> Result<ExportProgress, String> {
    // The frame travels as the raw request body (binary IPC). Taking it as a
    // `Vec<u8>` argument made Tauri JSON-encode ~1MB per frame as a number
    // array, which cost ~600ms/frame — the dominant export bottleneck.
    let tauri::ipc::InvokeBody::Raw(frame_data) = request.body() else {
        return Err("Expected raw binary frame data".to_string());
    };
    let session_id = request
        .headers()
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing x-session-id header")?
        .to_string();

    let mut sessions = EXPORT_SESSIONS.lock().await;
    
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;
    
    // Write frame data to FFmpeg stdin
    session
        .stdin
        .write_all(frame_data)
        .await
        .map_err(|e| format!("Failed to write frame: {}", e))?;
    
    session.current_frame += 1;
    
    // Calculate progress
    let progress = session.current_frame as f64 / session.total_frames as f64;
    let elapsed = session.start_time.elapsed().as_secs_f64();
    let fps = session.current_frame as f64 / elapsed;
    let remaining_frames = session.total_frames - session.current_frame;
    let eta_seconds = if fps > 0.0 {
        remaining_frames as f64 / fps
    } else {
        0.0
    };
    
    // Send progress update
    let progress_update = ExportProgress {
        current_frame: session.current_frame,
        total_frames: session.total_frames,
        progress,
        eta_seconds,
        fps,
    };
    
    // Log progress periodically
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

/// Finalize the export session.
///
/// Closes stdin and waits for FFmpeg to finish encoding.
#[tauri::command]
pub async fn finalize_video_export(session_id: String) -> Result<(), String> {
    let mut sessions = EXPORT_SESSIONS.lock().await;
    
    let session = sessions
        .remove(&session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;
    
    // Close stdin to signal end of input
    drop(session.stdin);
    
    // Wait for FFmpeg to finish
    let output = session
        .process
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;
    
    let elapsed = session.start_time.elapsed();
    
    if output.status.success() {
        eprintln!(
            "[finalize_video_export] Session {} completed successfully in {:.2}s ({} frames)",
            session_id,
            elapsed.as_secs_f64(),
            session.current_frame
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "[finalize_video_export] Session {} failed:\n{}",
            session_id, stderr
        );
        Err(format!("FFmpeg failed: {}", stderr))
    }
}

/// Cancel an export session.
///
/// Kills the FFmpeg process and cleans up resources.
#[tauri::command]
pub async fn cancel_video_export(session_id: String) -> Result<(), String> {
    let mut sessions = EXPORT_SESSIONS.lock().await;
    
    let mut session = sessions
        .remove(&session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;
    
    // Kill FFmpeg process
    session
        .process
        .kill()
        .await
        .map_err(|e| format!("Failed to kill FFmpeg: {}", e))?;
    
    eprintln!(
        "[cancel_video_export] Session {} cancelled ({} frames written)",
        session_id, session.current_frame
    );
    
    Ok(())
}

/// Check if FFmpeg is available on the system.
#[tauri::command]
pub async fn check_ffmpeg_available() -> Result<bool, String> {
    let output = Command::new(resolve_ffmpeg_path("ffmpeg"))
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
    let output = Command::new(resolve_ffmpeg_path("ffmpeg"))
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
        AudioInput { path: "x.wav".into(), start_time: start, trim_in: trim, duration: dur, volume: 1.0, fade_in: 0.0, fade_out: 0.0, channels: 2 }
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
        assert_eq!(label, "a0");
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
        assert!(graph.contains("[mix]alimiter=limit=0.97:level=0[aout]"));
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
