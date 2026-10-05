//! Voice enhancement ("Mejora de audio"): cleans up a voice recording without touching its pitch.
//!
//! The original file is never modified. A processed copy is written next to it
//! (`<name>_mejorado.<ext>`) and the editor swaps the timeline over to it, so the result is exactly
//! what plays in the preview and what gets exported.
//!
//! The chain (no pitch shifting, no time stretching anywhere, so the voice keeps its tone):
//!   1. high-pass at 80 Hz: removes rumble, handling noise and wind
//!   2. FFT noise reduction told the noise floor of THIS recording (measured first, see
//!      `noise_floor_from_levels`). Measured on a synthetic voice: with the right floor the
//!      speech-to-noise ratio improves by ~5 dB; with a wrong one it gets worse, which is why the
//!      floor is measured instead of guessed.
//!   3. a small cut in the muddy low-mids and a small lift in the presence region (clarity)
//!   4. a gentle compressor so loud and quiet phrases sit closer together
//!   5. loudness normalisation to -16 LUFS (the usual level for spoken word), then a limiter.
//!      Normalising LAST keeps the compressor from lifting the background noise.
//! Breaths are deliberately left alone: removing them automatically makes speech sound chopped.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::commands::export::{resolve_ffmpeg_path, tokio_command};

/// How strongly to clean: `soft`, `normal` (default) or `strong`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceLevel {
    Soft,
    Normal,
    Strong,
}

impl VoiceLevel {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "soft" | "suave" => VoiceLevel::Soft,
            "strong" | "fuerte" => VoiceLevel::Strong,
            _ => VoiceLevel::Normal,
        }
    }

    /// (noise reduction dB, compressor ratio, presence boost dB)
    fn settings(self) -> (f64, f64, f64) {
        match self {
            VoiceLevel::Soft => (12.0, 2.0, 1.0),
            VoiceLevel::Normal => (18.0, 3.0, 2.0),
            VoiceLevel::Strong => (26.0, 4.0, 2.5),
        }
    }
}

/// Used when the recording's noise floor can't be measured (e.g. no pauses at all): a typical quiet room.
pub const DEFAULT_NOISE_FLOOR_DB: f64 = -50.0;

/// Quietest and loudest noise floors (dBFS) we trust. Above the upper bound the "floor" is probably
/// speech itself, and telling the denoiser that speech is noise would damage the voice.
const MIN_NOISE_FLOOR_DB: f64 = -75.0;
const MAX_NOISE_FLOOR_DB: f64 = -38.0;

/// Estimates the background noise level from short-window RMS readings (dBFS): the quietest tenth
/// of the windows are the pauses between phrases. Ignores digital silence. `None` if there is nothing usable.
pub fn noise_floor_from_levels(levels: &[f64]) -> Option<f64> {
    let mut audible: Vec<f64> = levels.iter().copied().filter(|l| l.is_finite() && *l > -90.0).collect();
    if audible.len() < 5 {
        return None;
    }
    audible.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let floor = audible[audible.len() / 10];
    Some(floor.clamp(MIN_NOISE_FLOOR_DB, MAX_NOISE_FLOOR_DB))
}

/// Pulls the RMS readings out of ffmpeg's `ametadata=print` output.
pub fn parse_rms_levels(output: &str) -> Vec<f64> {
    output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("lavfi.astats.Overall.RMS_level="))
        .filter_map(|v| v.trim().parse::<f64>().ok())
        .collect()
}

/// The `-af` filter chain for a level and a measured noise floor (dBFS).
pub fn voice_filter(level: VoiceLevel, noise_floor_db: f64) -> String {
    let (noise_reduction, ratio, presence) = level.settings();
    let floor = noise_floor_db.clamp(-80.0, -20.0);
    [
        "highpass=f=80".to_string(),
        format!("afftdn=nr={:.1}:nf={:.1}", noise_reduction, floor),
        "equalizer=f=250:t=q:w=1.2:g=-1.5".to_string(),
        format!("equalizer=f=3500:t=q:w=1.0:g={:.1}", presence),
        format!("acompressor=threshold=-20dB:ratio={:.1}:attack=8:release=140:makeup=1", ratio),
        "loudnorm=I=-16:TP=-1.5:LRA=11".to_string(),
        // loudnorm resamples internally to 192 kHz; bring it back to a normal rate before the limiter.
        "aresample=48000".to_string(),
        "alimiter=limit=0.89:level=0".to_string(),
    ]
    .join(",")
}

/// `<dir>/<stem>_mejorado<ext>`, or `<stem>_mejorado 2<ext>`, `3`, ... if that name is taken.
pub fn enhanced_output_path(input: &Path, extension: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let dir = input.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "audio".to_string());
    let mut n = 1u32;
    loop {
        let suffix = if n == 1 { String::new() } else { format!(" {}", n) };
        let candidate = dir.join(format!("{}_mejorado{}.{}", stem, suffix, extension));
        if !exists(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Container for a processed video: keep mp4/mov/mkv, anything else goes to mp4 (AAC audio fits everywhere).
fn video_extension(input: &Path) -> &'static str {
    match input.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("mov") => "mov",
        Some("mkv") => "mkv",
        _ => "mp4",
    }
}

/// Builds the ffmpeg arguments (without the program name).
pub fn enhance_args(input: &str, output: &str, is_video: bool, level: VoiceLevel, noise_floor_db: f64) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", input].iter().map(|s| s.to_string()).collect();
    if is_video {
        // The picture is copied untouched (fast, lossless); only the first audio stream is rebuilt.
        args.extend(["-map", "0:v:0", "-c:v", "copy", "-map", "0:a:0"].iter().map(|s| s.to_string()));
    } else {
        args.extend(["-vn", "-map", "0:a:0"].iter().map(|s| s.to_string()));
    }
    args.extend(["-af".to_string(), voice_filter(level, noise_floor_db)]);
    args.extend(["-c:a", "aac", "-b:a", "256k"].iter().map(|s| s.to_string()));
    if is_video {
        args.extend(["-movflags", "+faststart"].iter().map(|s| s.to_string()));
    }
    args.push(output.to_string());
    args
}

/// Measures the recording's background noise level (dBFS) with a quick analysis pass.
async fn measure_noise_floor(input: &str) -> Option<f64> {
    let out = tokio_command(resolve_ffmpeg_path("ffmpeg"))
        .args([
            "-hide_banner", "-nostdin", "-v", "error", "-i", input, "-vn", "-map", "0:a:0", "-af",
            "highpass=f=80,astats=metadata=1:reset=1:length=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
            "-f", "null", "-",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    noise_floor_from_levels(&parse_rms_levels(&String::from_utf8_lossy(&out.stdout)))
}

/// Creates the enhanced copy and returns its path. The original is left as it was.
#[tauri::command]
pub async fn enhance_voice_audio(input_path: String, is_video: bool, level: Option<String>) -> Result<String, String> {
    let input = Path::new(&input_path);
    if !input.is_file() {
        return Err(format!("No se encontro el archivo: {}", input_path));
    }

    let extension = if is_video { video_extension(input) } else { "m4a" };
    let output = enhanced_output_path(input, extension, |p| p.exists());
    let output_str = output.to_str().ok_or("La ruta de salida no es valida")?.to_string();
    let level = VoiceLevel::parse(level.as_deref().unwrap_or("normal"));
    let noise_floor = measure_noise_floor(&input_path).await.unwrap_or(DEFAULT_NOISE_FLOOR_DB);

    let result = tokio_command(resolve_ffmpeg_path("ffmpeg"))
        .args(enhance_args(&input_path, &output_str, is_video, level, noise_floor))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("No se pudo ejecutar ffmpeg: {}", e))?;

    if !result.status.success() {
        let _ = std::fs::remove_file(&output);
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("error desconocido").trim().to_string();
        if detail.contains("matches no streams") || detail.contains("Stream map") {
            return Err("Este archivo no tiene audio que mejorar.".to_string());
        }
        return Err(format!("No se pudo mejorar el audio: {}", detail));
    }

    Ok(output_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_parsing_defaults_to_normal() {
        assert_eq!(VoiceLevel::parse("soft"), VoiceLevel::Soft);
        assert_eq!(VoiceLevel::parse("Fuerte"), VoiceLevel::Strong);
        assert_eq!(VoiceLevel::parse("normal"), VoiceLevel::Normal);
        assert_eq!(VoiceLevel::parse("???"), VoiceLevel::Normal);
    }

    #[test]
    fn filter_never_changes_pitch_or_speed() {
        for level in [VoiceLevel::Soft, VoiceLevel::Normal, VoiceLevel::Strong] {
            let f = voice_filter(level, -50.0);
            for forbidden in ["asetrate", "atempo", "rubberband", "aresample=44100:", "pitch"] {
                assert!(!f.contains(forbidden), "{} must not appear in {}", forbidden, f);
            }
            assert!(f.contains("afftdn") && f.contains("highpass") && f.contains("loudnorm") && f.ends_with("alimiter=limit=0.89:level=0"));
        }
    }

    #[test]
    fn stronger_levels_clean_more() {
        assert!(voice_filter(VoiceLevel::Soft, -50.0).contains("afftdn=nr=12.0"));
        assert!(voice_filter(VoiceLevel::Normal, -50.0).contains("afftdn=nr=18.0"));
        assert!(voice_filter(VoiceLevel::Strong, -50.0).contains("afftdn=nr=26.0"));
    }

    #[test]
    fn the_measured_noise_floor_goes_into_the_denoiser_and_loudness_comes_last() {
        let f = voice_filter(VoiceLevel::Normal, -61.3);
        assert!(f.contains("afftdn=nr=18.0:nf=-61.3"), "{}", f);
        let compressor = f.find("acompressor").unwrap();
        let loudnorm = f.find("loudnorm").unwrap();
        assert!(compressor < loudnorm, "normalise after compressing so the noise isn't lifted: {}", f);
        // out-of-range values are clamped to what ffmpeg accepts
        assert!(voice_filter(VoiceLevel::Normal, -200.0).contains("nf=-80.0"));
    }

    #[test]
    fn noise_floor_is_the_quiet_tenth_of_the_windows() {
        // 8 loud (speech) windows and 2 quiet (pause) ones
        let levels = [-16.0, -15.5, -16.2, -17.0, -45.0, -16.0, -15.8, -46.0, -16.1, -15.9];
        assert_eq!(noise_floor_from_levels(&levels), Some(-45.0)); // the quietest tenth, not the single quietest window
        // digital silence and non-numbers are ignored
        let with_silence = [f64::NEG_INFINITY, -100.0, -50.0, -50.0, -20.0, -20.0, -20.0, -20.0, -20.0, -20.0];
        assert_eq!(noise_floor_from_levels(&with_silence), Some(-50.0));
        // not enough data: no guess
        assert_eq!(noise_floor_from_levels(&[-30.0, -31.0]), None);
        assert_eq!(noise_floor_from_levels(&[]), None);
    }

    #[test]
    fn a_floor_that_is_really_speech_is_capped_instead_of_trusted() {
        // continuous speech with no pauses: the quietest window is still loud
        let levels = vec![-18.0; 20];
        assert_eq!(noise_floor_from_levels(&levels), Some(-38.0));
        // an implausibly low floor is raised to the lower bound
        assert_eq!(noise_floor_from_levels(&vec![-88.0; 20]), Some(-75.0));
    }

    #[test]
    fn rms_levels_are_read_from_ffmpegs_metadata_output() {
        let text = "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-16.649884\nframe:1    pts:4096    pts_time:0.0853333\nlavfi.astats.Overall.RMS_level=-inf\nlavfi.astats.Overall.RMS_level=-40.5\n";
        let levels = parse_rms_levels(text);
        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0], -16.649884);
        assert!(levels[1].is_infinite());
        assert_eq!(levels[2], -40.5);
    }

    #[test]
    fn output_name_sits_next_to_the_original_and_never_overwrites() {
        let input = Path::new("C:/voz/nota.m4a");
        assert_eq!(enhanced_output_path(input, "m4a", |_| false), PathBuf::from("C:/voz/nota_mejorado.m4a"));
        let taken: Vec<PathBuf> = vec![PathBuf::from("C:/voz/nota_mejorado.m4a"), PathBuf::from("C:/voz/nota_mejorado 2.m4a")];
        assert_eq!(enhanced_output_path(input, "m4a", |p| taken.iter().any(|t| t == p)), PathBuf::from("C:/voz/nota_mejorado 3.m4a"));
    }

    #[test]
    fn video_keeps_the_picture_and_audio_files_drop_any_video() {
        let video = enhance_args("in.mp4", "out.mp4", true, VoiceLevel::Normal, -50.0);
        assert!(video.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(video.contains(&"+faststart".to_string()));
        let audio = enhance_args("in.m4a", "out.m4a", false, VoiceLevel::Normal, -50.0);
        assert!(audio.contains(&"-vn".to_string()));
        assert!(!audio.iter().any(|a| a == "copy"));
        assert_eq!(audio.last().unwrap(), "out.m4a");
        assert!(audio.contains(&"-n".to_string()), "must never overwrite an existing file");
    }

    #[test]
    fn video_containers_fall_back_to_mp4() {
        assert_eq!(video_extension(Path::new("a.MOV")), "mov");
        assert_eq!(video_extension(Path::new("a.mkv")), "mkv");
        assert_eq!(video_extension(Path::new("a.avi")), "mp4");
        assert_eq!(video_extension(Path::new("a.webm")), "mp4");
    }
}
