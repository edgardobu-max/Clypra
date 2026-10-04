use crate::thumbnail_engine::decoder::get_decoder;
use crate::models::{VideoMetadata, MediaMetadata};
use base64::Engine;
use image::ImageEncoder;
use std::fs;

/// Unified media metadata extraction for images, videos, and audio.
/// Professional NLE approach: single probe pipeline for all media types.
#[tauri::command]
pub async fn get_media_metadata(path: String) -> Result<MediaMetadata, String> {
    eprintln!("🦀 [get_media_metadata] Probing: {}", path);
    
    // Determine media type from extension
    let extension = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    match extension.as_str() {
        // Image formats - use image crate for native decoding
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tiff" | "tif" => {
            get_image_metadata(&path).await
        }
        // Video/audio formats - use FFmpeg decoder
        _ => get_video_metadata_internal(&path).await,
    }
}

/// Extract metadata from image files using the image crate.
/// Handles: dimensions, alpha channel, EXIF orientation.
async fn get_image_metadata(path: &str) -> Result<MediaMetadata, String> {
    use image::GenericImageView;
    
    eprintln!("🦀 [get_image_metadata] Loading image: {}", path);
    
    // Load image to extract metadata
    let img = image::open(path)
        .map_err(|e| format!("Failed to open image: {}", e))?;
    
    let (width, height) = img.dimensions();
    
    // Check for alpha channel
    let has_alpha = matches!(
        img.color(),
        image::ColorType::La8 | image::ColorType::La16 |
        image::ColorType::Rgba8 | image::ColorType::Rgba16 |
        image::ColorType::Rgba32F
    );
    
    // Get file size
    let size = fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);
    
    eprintln!("🦀 [get_image_metadata] Dimensions: {}×{}, Alpha: {}", width, height, has_alpha);
    
    Ok(MediaMetadata {
        duration: 0.0,
        width,
        height,
        fps: 0.0,
        size,
        rotation: None,
        has_alpha: Some(has_alpha),
    })
}

/// Extract metadata from video/audio files using FFmpeg decoder.
/// Handles: dimensions, duration, fps, rotation, SAR.
async fn get_video_metadata_internal(path: &str) -> Result<MediaMetadata, String> {
    match get_decoder(path).await {
        Ok(decoder) => {
            let guard = decoder.lock().await;
            
            // ✅ Use display_dimensions() which handles SAR + rotation
            let (width, height) = guard.display_dimensions();
            
            let duration = guard.duration;
            let fps = guard.fps();
            let rotation = guard.rotation();
            
            drop(guard);
            
            let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);

            eprintln!("🦀 [get_video_metadata_internal] Display dimensions: {}×{}, Rotation: {}°", width, height, rotation);

            Ok(MediaMetadata {
                duration,
                width,
                height,
                fps,
                size,
                rotation: if rotation != 0 { Some(rotation) } else { None },
                has_alpha: None,
            })
        }
        Err(e) if e.contains("No video stream") => {
            // Audio-only file
            let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let duration = get_audio_duration(path).await.unwrap_or(0.0);
            
            Ok(MediaMetadata {
                duration,
                width: 0,
                height: 0,
                fps: 0.0,
                size,
                rotation: None,
                has_alpha: None,
            })
        }
        Err(e) => Err(e),
    }
}

/// Legacy command for backward compatibility.
/// New code should use get_media_metadata instead.
#[tauri::command]
pub async fn get_video_metadata(path: String) -> Result<VideoMetadata, String> {
    get_video_metadata_internal(&path).await
}

async fn get_audio_duration(path: &str) -> Result<f64, String> {
    use std::process::Command;
    
    eprintln!("[get_audio_duration] Attempting to get duration for: {}", path);
    
    let output = Command::new(crate::commands::export::resolve_ffmpeg_path("ffprobe"))
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .map_err(|e| {
            eprintln!("[get_audio_duration] Failed to run ffprobe: {}", e);
            format!("Failed to run ffprobe: {}", e)
        })?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[get_audio_duration] ffprobe failed: {}", stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }
    
    let duration_str = String::from_utf8_lossy(&output.stdout);
    eprintln!("[get_audio_duration] ffprobe output: {}", duration_str);
    
    let duration = duration_str.trim().parse::<f64>()
        .map_err(|e| {
            eprintln!("[get_audio_duration] Failed to parse duration '{}': {}", duration_str, e);
            format!("Failed to parse duration: {}", e)
        })?;
    
    eprintln!("[get_audio_duration] Successfully parsed duration: {}s", duration);
    Ok(duration)
}

#[tauri::command]
pub async fn extract_poster_frame(path: String, time: f64) -> Result<String, String> {
    use image::codecs::png::PngEncoder;
    
    eprintln!("[extract_poster_frame] Extracting frame at {}s from {}", time, path);
    
    let decoder = get_decoder(&path).await?;
    
    let rgba_bytes = {
        let mut guard = decoder.lock().await;
        guard.decode_frame(time, 160, 90)?
    };
    
    let mut png_data = Vec::new();
    let encoder = PngEncoder::new(&mut png_data);
    encoder.write_image(&rgba_bytes, 160, 90, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG encoding failed: {}", e))?;
    
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png_data);
    Ok(format!("data:image/png;base64,{}", encoded))
}

#[tauri::command]
pub async fn extract_audio_artwork(path: String) -> Result<Option<String>, String> {
    use std::process::Command;
    
    eprintln!("[extract_audio_artwork] Extracting artwork from: {}", path);
    
    let output = Command::new(crate::commands::export::resolve_ffmpeg_path("ffmpeg"))
        .args([
            "-i", &path,
            "-an", // No audio
            "-vcodec", "copy",
            "-f", "image2pipe",
            "-vframes", "1",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    
    if !output.status.success() || output.stdout.is_empty() {
        eprintln!("[extract_audio_artwork] No artwork found");
        return Ok(None);
    }
    
    let encoded = base64::engine::general_purpose::STANDARD.encode(&output.stdout);
    let mime_type = "image/jpeg"; // Most audio artwork is JPEG
    
    eprintln!("[extract_audio_artwork] Extracted artwork ({} bytes)", output.stdout.len());
    Ok(Some(format!("data:{};base64,{}", mime_type, encoded)))
}

#[tauri::command]
pub async fn extract_audio_track(path: String) -> Result<String, String> {
    use std::process::Command;
    use std::path::Path;
    use std::fs;

    eprintln!("🦀 [extract_audio_track] Extracting audio from: {}", path);

    // Create a temporary directory inside the workspace if it doesn't exist
    let temp_dir = Path::new("temp");
    if !temp_dir.exists() {
        fs::create_dir_all(temp_dir).map_err(|e| format!("Failed to create temp directory: {}", e))?;
    }

    // Generate a unique filename using MD5 of path
    let hash = format!("{:x}", md5::compute(path.as_bytes()));
    let output_filename = format!("{}.mp3", hash);
    let output_path = temp_dir.join(output_filename);
    let output_path_str = output_path.to_str().ok_or("Failed to convert output path to string")?.to_string();

    // Call ffmpeg command to extract audio: ffmpeg -i <path> -vn -acodec libmp3lame -ac 1 -ar 16000 -y <output_path>
    let output = Command::new(crate::commands::export::resolve_ffmpeg_path("ffmpeg"))
        .args([
            "-i", &path,
            "-vn",
            "-acodec", "libmp3lame",
            "-ac", "1",
            "-ar", "16000",
            "-y",
            &output_path_str,
        ])
        .output()
        .map_err(|e| format!("Failed to execute ffmpeg for audio extraction: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg audio extraction failed: {}", stderr));
    }

    // Get the absolute path of the output file
    let abs_path = fs::canonicalize(output_path)
        .map_err(|e| format!("Failed to resolve absolute path of extracted audio: {}", e))?;
    
    let abs_path_str = abs_path.to_str().ok_or("Failed to convert absolute path to string")?.to_string();
    eprintln!("🦀 [extract_audio_track] Extracted audio saved to: {}", abs_path_str);

    Ok(abs_path_str)
}

/// Locate `uv`: PATH first, then the usual per-user install locations. A GUI app
/// launched before `uv` was installed keeps its old PATH, so PATH alone isn't enough.
fn resolve_uv_path() -> std::path::PathBuf {
    use std::path::PathBuf;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&home).join(".local").join("bin").join("uv.exe"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(local.join("Microsoft").join("WinGet").join("Links").join("uv.exe"));
        if let Ok(entries) = std::fs::read_dir(local.join("Microsoft").join("WinGet").join("Packages")) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("astral-sh.uv") {
                    candidates.push(entry.path().join("uv.exe"));
                }
            }
        }
    }
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("uv.exe").exists() || d.join("uv").exists()))
        .unwrap_or(false);
    if on_path {
        return PathBuf::from("uv");
    }
    candidates.into_iter().find(|c| c.exists()).unwrap_or_else(|| PathBuf::from("uv"))
}

#[tauri::command]
pub async fn transcribe_audio_local(audio_path: String, language: Option<String>, script: Option<String>) -> Result<String, String> {
    use std::process::Command;
    use std::fs;
    use std::path::PathBuf;

    eprintln!("🦀 [transcribe_audio_local] Transcribing: {}", audio_path);

    // Resolve script path robustly to handle different current working directories in Tauri
    let mut script_path = PathBuf::from("src/features/text-effects/transcribe.py");
    if !script_path.exists() {
        script_path = PathBuf::from("../src/features/text-effects/transcribe.py");
    }
    if !script_path.exists() {
        let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        for _ in 0..4 {
            let test_path = dir.join("src/features/text-effects/transcribe.py");
            if test_path.exists() {
                script_path = test_path;
                break;
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    let script_path_str = script_path.to_str().ok_or("Failed to convert script path to string")?.to_string();
    eprintln!("🦀 [transcribe_audio_local] Resolved script path: {}", script_path_str);

    // Call uv command to run our python script: uv run <resolved_script_path> <audio_path>
    // The script shells out to ffmpeg; hand it the resolved binary so it never
    // picks up the non-executable stub in src-tauri/bin (WinError 216).
    let ffmpeg_path = crate::commands::export::resolve_ffmpeg_path("ffmpeg");

    // Optional script: when present the captions' text comes from it and only the
    // timing from the audio. Passed through a temp file (length/encoding safe).
    let script_file = match script.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let path = std::env::temp_dir().join(format!("clypra-script-{}.txt", nanos));
            fs::write(&path, text).map_err(|e| format!("Failed to write script file: {}", e))?;
            Some(path)
        }
        None => None,
    };

    let mut uv_args: Vec<String> = vec![
        "run".to_string(),
        script_path_str.clone(),
        audio_path.clone(),
        language.clone().unwrap_or_else(|| "auto".to_string()),
        "small".to_string(),
    ];
    if let Some(path) = &script_file {
        uv_args.push(path.to_string_lossy().to_string());
    }

    let output = Command::new(resolve_uv_path())
        .env("FFMPEG_PATH", &ffmpeg_path)
        .args(&uv_args)
        .output()
        .map_err(|e| format!("Failed to execute uv transcription: {}", e))?;

    if let Some(path) = &script_file {
        let _ = fs::remove_file(path);
    }

    // Delete the temporary audio file since transcription is completed (to prevent disk bloat)
    if let Err(e) = fs::remove_file(&audio_path) {
        eprintln!("⚠️ [transcribe_audio_local] Failed to clean up temporary audio file: {}", e);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Whisper transcription failed: {}", stderr));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    Ok(stdout_str.trim().to_string())
}

/// Writes raw bytes (a PNG/JPEG cover image) to `x-path` (percent-encoded header).
/// The body travels as binary IPC, same as export frames, instead of a JSON array.
#[tauri::command]
pub async fn save_image_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw binary image data".to_string());
    };
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing x-path header")?;
    let path = percent_decode(encoded)?;
    let lower = path.to_lowercase();
    if !(lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")) {
        return Err("Cover images must be saved as .png or .jpg".to_string());
    }
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write {}: {}", path, e))
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = input.get(i + 1..i + 3).ok_or("Bad percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Bad percent-encoding".to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Path is not valid UTF-8".to_string())
}
