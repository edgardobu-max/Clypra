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
use tauri::ipc::Channel;
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

/// Start a video export session.
///
/// Returns a session ID that can be used to write frames and finalize.
#[tauri::command]
pub async fn start_video_export(config: ExportConfig) -> Result<String, String> {
    // Generate session ID
    let session_id = uuid::Uuid::new_v4().to_string();
    
    // Build FFmpeg command
    let mut cmd = Command::new(resolve_ffmpeg_path("ffmpeg"));
    
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
pub async fn write_export_frame(
    session_id: String,
    frame_data: Vec<u8>,
    on_progress: Channel<ExportProgress>,
) -> Result<(), String> {
    let mut sessions = EXPORT_SESSIONS.lock().await;
    
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Export session not found: {}", session_id))?;
    
    // Write frame data to FFmpeg stdin
    session
        .stdin
        .write_all(&frame_data)
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
    
    let _ = on_progress.send(progress_update);
    
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
    
    Ok(())
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
