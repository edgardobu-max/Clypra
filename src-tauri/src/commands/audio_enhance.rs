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
//!
//! Two optional steps run BEFORE that chain, using code written by the FilmCraft project (vendored, see
//! `vendor/filmcraft-audio-dsp/VENDORED.md`): DeReverb removes the echo of the room and DeEsser
//! softens harsh "s" sounds. They stream through Rust in blocks (ffmpeg decodes, Rust processes,
//! ffmpeg stores a lossless FLAC), so long recordings do not need to fit in memory.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use filmcraft_audio_dsp::AudioEffect;
use filmcraft_audio_dsp::effects::{DeEsser, DeReverb};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::commands::export::{probe_audio_channels, resolve_ffmpeg_path, tokio_command};

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

/// Which of the optional room/sibilance cleanups to run before the main chain.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpeechCleanup {
    /// Remove the echo of the room (DeReverb).
    pub dereverb: bool,
    /// Soften harsh "s" sounds (DeEsser).
    pub deess: bool,
}

impl SpeechCleanup {
    pub fn any(self) -> bool {
        self.dereverb || self.deess
    }
}

impl VoiceLevel {
    /// DeReverb amount, percent.
    fn dereverb_amount(self) -> f32 {
        match self {
            VoiceLevel::Soft => 30.0,
            VoiceLevel::Normal => 50.0,
            VoiceLevel::Strong => 70.0,
        }
    }

    /// DeEsser (threshold dB, max reduction dB).
    fn deesser_settings(self) -> (f32, f32) {
        match self {
            VoiceLevel::Soft => (-12.0, 5.0),
            VoiceLevel::Normal => (-12.0, 8.0),
            VoiceLevel::Strong => (-14.0, 12.0),
        }
    }
}

/// Sample rate of the cleanup stage.
pub const SPEECH_SAMPLE_RATE: u32 = 48_000;

/// Frames processed per block.
const BLOCK_FRAMES: usize = 8192;

/// The streaming DeReverb -> DeEsser chain. Feed it interleaved f32 blocks of any size; the output has
/// exactly as many samples as the input (the effects' own delay is cancelled), so the voice stays in
/// sync with the picture.
pub struct SpeechChain {
    effects: Vec<Box<dyn AudioEffect>>,
    channels: usize,
    /// Latency still to be dropped from the start of the output, in frames.
    skip: usize,
    /// Total latency of the chain, in frames.
    latency: usize,
}

impl SpeechChain {
    /// `None` when no step is enabled.
    pub fn new(cleanup: SpeechCleanup, level: VoiceLevel, channels: usize, sample_rate: u32) -> Option<Self> {
        if !cleanup.any() {
            return None;
        }
        let channels = channels.clamp(1, 2);
        let sr = sample_rate as f32;
        let mut effects: Vec<Box<dyn AudioEffect>> = Vec::new();
        if cleanup.dereverb {
            let mut e = DeReverb::new(sr, channels);
            e.set_param("amount", level.dereverb_amount());
            effects.push(Box::new(e));
        }
        if cleanup.deess {
            let (threshold, reduction) = level.deesser_settings();
            let mut e = DeEsser::new(sr, channels);
            e.set_param("threshold", threshold);
            e.set_param("reduction", reduction);
            effects.push(Box::new(e));
        }
        let latency: usize = effects.iter().map(|e| e.latency()).sum();
        Some(SpeechChain { effects, channels, skip: latency, latency })
    }

    /// Processes one block of interleaved samples (a whole number of frames) and returns the output
    /// that is ready, interleaved.
    pub fn process(&mut self, interleaved: &[f32]) -> Vec<f32> {
        let ch = self.channels;
        let frames = interleaved.len() / ch;
        let mut planar: Vec<Vec<f32>> = (0..ch).map(|c| (0..frames).map(|f| interleaved[f * ch + c]).collect()).collect();
        for effect in self.effects.iter_mut() {
            let mut refs: Vec<&mut [f32]> = planar.iter_mut().map(|v| v.as_mut_slice()).collect();
            effect.process(&mut refs);
        }
        let drop_frames = self.skip.min(frames);
        self.skip -= drop_frames;
        let mut out = Vec::with_capacity((frames - drop_frames) * ch);
        for f in drop_frames..frames {
            for c in 0..ch {
                out.push(planar[c][f]);
            }
        }
        out
    }

    /// Call once at the end of the input: pushes silence through to collect the last frames the effects
    /// were still holding.
    pub fn finish(&mut self) -> Vec<f32> {
        let silence = vec![0.0f32; self.latency * self.channels];
        self.process(&silence)
    }
}

/// Little-endian f32 bytes -> samples (a trailing partial sample is ignored).
pub fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

pub fn f32_to_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Removes the temporary file when dropped, also on early returns and errors.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Runs the room/sibilance cleanup over the recording and stores the result as a lossless FLAC.
async fn run_speech_stage(input: &str, output: &Path, cleanup: SpeechCleanup, level: VoiceLevel, channels: usize) -> Result<(), String> {
    let mut chain = SpeechChain::new(cleanup, level, channels, SPEECH_SAMPLE_RATE).ok_or("Nada que limpiar")?;
    let ch = channels.clamp(1, 2);
    let ch_arg = ch.to_string();
    let ffmpeg = resolve_ffmpeg_path("ffmpeg");

    let mut decoder = tokio_command(&ffmpeg)
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i", input, "-vn", "-map", "0:a:0", "-ac", &ch_arg, "-ar", "48000", "-f", "f32le", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar ffmpeg: {}", e))?;
    let output_str = output.to_str().ok_or("La ruta temporal no es valida")?;
    let mut encoder = tokio_command(&ffmpeg)
        .args(["-hide_banner", "-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", &ch_arg, "-i", "pipe:0", "-c:a", "flac", output_str])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar ffmpeg: {}", e))?;

    let mut source = decoder.stdout.take().ok_or("No se pudo leer el audio")?;
    let mut sink = encoder.stdin.take().ok_or("No se pudo escribir el audio")?;

    let frame_bytes = 4 * ch;
    let mut buf = vec![0u8; BLOCK_FRAMES * frame_bytes];
    let mut carry: Vec<u8> = Vec::new();
    let mut total_frames: u64 = 0;
    loop {
        let n = source.read(&mut buf).await.map_err(|e| format!("Error leyendo el audio: {}", e))?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / frame_bytes * frame_bytes;
        if whole == 0 {
            continue;
        }
        let samples = bytes_to_f32(&carry[..whole]);
        carry.drain(..whole);
        total_frames += (samples.len() / ch) as u64;
        let processed = chain.process(&samples);
        sink.write_all(&f32_to_bytes(&processed)).await.map_err(|e| format!("Error escribiendo el audio: {}", e))?;
    }
    if total_frames == 0 {
        let _ = decoder.kill().await;
        let _ = encoder.kill().await;
        return Err("Este archivo no tiene audio que mejorar.".to_string());
    }
    sink.write_all(&f32_to_bytes(&chain.finish())).await.map_err(|e| format!("Error escribiendo el audio: {}", e))?;
    drop(sink);

    let _ = decoder.wait().await;
    let result = encoder.wait_with_output().await.map_err(|e| format!("ffmpeg fallo: {}", e))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("No se pudo limpiar el audio: {}", stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("error desconocido").trim()));
    }
    Ok(())
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

/// Delay the chain adds (afftdn 25 ms + alimiter 5 ms), measured by cross-correlating input and output.
pub const FILTER_LATENCY_SECONDS: f64 = 0.030;

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
        // afftdn (25 ms) and alimiter (5 ms) delay the signal; measured 30.0 ms end to end. Dropping that
        // much from the start keeps the voice in sync with the picture of a video.
        format!("atrim=start={:.3},asetpts=PTS-STARTPTS", FILTER_LATENCY_SECONDS),
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
///
/// `cleaned_audio` is the output of the room/sibilance stage. For a video it becomes a second input
/// (the picture still comes from `input`); for an audio file it replaces `input`.
pub fn enhance_args(input: &str, cleaned_audio: Option<&str>, output: &str, is_video: bool, level: VoiceLevel, noise_floor_db: f64) -> Vec<String> {
    let first_input = if is_video { input } else { cleaned_audio.unwrap_or(input) };
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", first_input].iter().map(|s| s.to_string()).collect();
    if is_video {
        // The picture is copied untouched (fast, lossless); only the first audio stream is rebuilt.
        match cleaned_audio {
            Some(cleaned) => args.extend(["-i", cleaned, "-map", "0:v:0", "-c:v", "copy", "-map", "1:a:0"].iter().map(|s| s.to_string())),
            None => args.extend(["-map", "0:v:0", "-c:v", "copy", "-map", "0:a:0"].iter().map(|s| s.to_string())),
        }
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
pub async fn enhance_voice_audio(input_path: String, is_video: bool, level: Option<String>, dereverb: Option<bool>, deess: Option<bool>) -> Result<String, String> {
    let input = Path::new(&input_path);
    if !input.is_file() {
        return Err(format!("No se encontro el archivo: {}", input_path));
    }

    let extension = if is_video { video_extension(input) } else { "m4a" };
    let output = enhanced_output_path(input, extension, |p| p.exists());
    let output_str = output.to_str().ok_or("La ruta de salida no es valida")?.to_string();
    let level = VoiceLevel::parse(level.as_deref().unwrap_or("normal"));
    let cleanup = SpeechCleanup { dereverb: dereverb.unwrap_or(false), deess: deess.unwrap_or(false) };

    // Optional first stage: room echo and harsh "s" removal into a temporary lossless file.
    let mut _temp_guard: Option<TempFile> = None;
    let mut cleaned: Option<String> = None;
    if cleanup.any() {
        let channels = probe_audio_channels(&input_path).await.unwrap_or(2) as usize;
        let temp = std::env::temp_dir().join(format!("mediadesk_voz_{}.flac", uuid::Uuid::new_v4()));
        _temp_guard = Some(TempFile(temp.clone()));
        run_speech_stage(&input_path, &temp, cleanup, level, channels).await?;
        cleaned = temp.to_str().map(|s| s.to_string());
    }

    let noise_floor = measure_noise_floor(cleaned.as_deref().unwrap_or(&input_path)).await.unwrap_or(DEFAULT_NOISE_FLOOR_DB);

    let result = tokio_command(resolve_ffmpeg_path("ffmpeg"))
        .args(enhance_args(&input_path, cleaned.as_deref(), &output_str, is_video, level, noise_floor))
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
            assert!(f.contains("afftdn") && f.contains("highpass") && f.contains("loudnorm") && f.contains("alimiter=limit=0.89:level=0"));
        }
    }

    #[test]
    fn the_filter_delay_is_cancelled_so_a_video_stays_in_sync() {
        let f = voice_filter(VoiceLevel::Normal, -50.0);
        assert!(f.ends_with("atrim=start=0.030,asetpts=PTS-STARTPTS"), "{}", f);
        let limiter = f.find("alimiter").unwrap();
        assert!(f.find("atrim").unwrap() > limiter, "compensate after the last delaying filter: {}", f);
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
        let video = enhance_args("in.mp4", None, "out.mp4", true, VoiceLevel::Normal, -50.0);
        assert!(video.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(video.contains(&"+faststart".to_string()));
        let audio = enhance_args("in.m4a", None, "out.m4a", false, VoiceLevel::Normal, -50.0);
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

    #[test]
    fn a_cleaned_video_takes_the_picture_from_the_original_and_the_sound_from_the_cleaned_file() {
        let video = enhance_args("in.mp4", Some("clean.flac"), "out.mp4", true, VoiceLevel::Normal, -50.0);
        let pos = |needle: &str| video.iter().position(|a| a == needle).unwrap();
        assert_eq!(video[pos("-i") + 1], "in.mp4");
        assert!(video.windows(2).any(|w| w == ["-i", "clean.flac"]));
        assert!(video.windows(2).any(|w| w == ["-map", "0:v:0"]));
        assert!(video.windows(2).any(|w| w == ["-map", "1:a:0"]));
        assert!(video.windows(2).any(|w| w == ["-c:v", "copy"]));
        // an audio file reads the cleaned copy instead of the original
        let audio = enhance_args("in.m4a", Some("clean.flac"), "out.m4a", false, VoiceLevel::Normal, -50.0);
        assert_eq!(audio[audio.iter().position(|a| a == "-i").unwrap() + 1], "clean.flac");
        assert!(!audio.contains(&"in.m4a".to_string()));
    }
}

#[cfg(test)]
mod speech_stage_integration {
    use super::*;
    use crate::commands::export::std_command;

    fn ffmpeg_ok(args: &[&str]) -> bool {
        std_command(resolve_ffmpeg_path("ffmpeg")).args(["-v", "error", "-y"]).args(args).status().map(|s| s.success()).unwrap_or(false)
    }

    /// (codec_type, codec_name, duration seconds) of every stream.
    fn probe(path: &str) -> Vec<(String, String, f64)> {
        let out = std_command(resolve_ffmpeg_path("ffprobe"))
            .args(["-v", "error", "-show_entries", "stream=codec_type,codec_name,duration", "-of", "csv=p=0", path])
            .output()
            .expect("ffprobe");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.trim().split(',').collect();
                // csv column order follows ffprobe's own field order: codec_name, codec_type, duration
                (p.len() >= 3).then(|| (p[1].to_string(), p[0].to_string(), p[2].parse::<f64>().unwrap_or(0.0)))
            })
            .collect()
    }

    /// These tests count the temporary files in the shared temp folder, so they must not overlap.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn temp_voice_files() -> usize {
        std::fs::read_dir(std::env::temp_dir()).map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("mediadesk_voz_")).count()).unwrap_or(0)
    }

    #[tokio::test]
    async fn cleaning_an_audio_file_keeps_its_length_and_leaves_no_temp_files() {
        let _serial = SERIAL.lock().await;
        let dir = std::env::temp_dir().join(format!("mediadesk_enh_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("nota.wav");
        assert!(ffmpeg_ok(&["-f", "lavfi", "-i", "sine=frequency=200:duration=3", "-ac", "1", "-ar", "44100", input.to_str().unwrap()]), "could not create the test audio");
        let before = temp_voice_files();

        let out = enhance_voice_audio(input.to_str().unwrap().to_string(), false, Some("normal".into()), Some(true), Some(true)).await.expect("enhance");
        assert!(out.ends_with("nota_mejorado.m4a"), "{}", out);
        let streams = probe(&out);
        let audio = streams.iter().find(|s| s.0 == "audio").expect("audio stream");
        assert!((audio.2 - 3.0).abs() < 0.2, "length changed: {}", audio.2);
        assert_eq!(temp_voice_files(), before, "the temporary FLAC was not removed");
        // the original is untouched and a second run never overwrites
        assert!(input.exists());
        let again = enhance_voice_audio(input.to_str().unwrap().to_string(), false, None, Some(true), None).await.expect("second run");
        assert!(again.ends_with("nota_mejorado 2.m4a"), "{}", again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cleaning_a_video_copies_the_picture_and_rebuilds_the_sound() {
        let _serial = SERIAL.lock().await;
        let dir = std::env::temp_dir().join(format!("mediadesk_enh_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("clip.mp4");
        assert!(ffmpeg_ok(&["-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=2", "-f", "lavfi", "-i", "sine=frequency=300:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input.to_str().unwrap()]), "could not create the test video");

        let out = enhance_voice_audio(input.to_str().unwrap().to_string(), true, None, Some(true), Some(true)).await.expect("enhance video");
        let streams = probe(&out);
        let video = streams.iter().find(|s| s.0 == "video").expect("video stream");
        let audio = streams.iter().find(|s| s.0 == "audio").expect("audio stream");
        assert_eq!(video.1, "h264", "the picture must be copied, not re-encoded");
        assert!((audio.2 - 2.0).abs() < 0.2, "audio length {}", audio.2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_without_sound_says_so_and_leaves_nothing_behind() {
        let _serial = SERIAL.lock().await;
        let dir = std::env::temp_dir().join(format!("mediadesk_enh_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("mudo.mp4");
        assert!(ffmpeg_ok(&["-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", input.to_str().unwrap()]));
        let before = temp_voice_files();
        let err = enhance_voice_audio(input.to_str().unwrap().to_string(), true, None, Some(true), None).await.unwrap_err();
        assert!(err.contains("no tiene audio"), "{}", err);
        assert_eq!(temp_voice_files(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod speech_chain_tests {
    use super::*;

    /// Small deterministic noise source.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
        }
    }

    fn run(chain: &mut SpeechChain, input: &[f32], block: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for chunk in input.chunks(block) {
            out.extend(chain.process(chunk));
        }
        out.extend(chain.finish());
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    fn db(v: f32) -> f32 {
        20.0 * v.max(1e-9).log10()
    }

    /// High-frequency energy proxy: RMS of the first difference.
    fn hf_rms(x: &[f32]) -> f32 {
        let d: Vec<f32> = x.windows(2).map(|w| w[1] - w[0]).collect();
        rms(&d)
    }

    fn seg(x: &[f32], sr: usize, from: f32, to: f32) -> &[f32] {
        &x[(from * sr as f32) as usize..(to * sr as f32) as usize]
    }

    /// Voiced sound: harmonics of 150 Hz.
    fn vowel(sr: usize, secs: f32, amp: f32) -> Vec<f32> {
        (0..(secs * sr as f32) as usize)
            .map(|i| {
                let t = i as f32 / sr as f32;
                amp * (1..=12).map(|k| (2.0 * std::f32::consts::PI * 150.0 * k as f32 * t).sin() / k as f32).sum::<f32>()
            })
            .collect()
    }

    #[test]
    fn nothing_enabled_means_no_chain() {
        assert!(SpeechChain::new(SpeechCleanup::default(), VoiceLevel::Normal, 1, 48_000).is_none());
        assert!(SpeechChain::new(SpeechCleanup { dereverb: true, deess: false }, VoiceLevel::Normal, 1, 48_000).is_some());
    }

    #[test]
    fn samples_survive_the_byte_round_trip() {
        let samples = [0.0f32, 1.0, -1.0, 0.123456, -0.5e-7];
        assert_eq!(bytes_to_f32(&f32_to_bytes(&samples)), samples);
        // a trailing partial sample is ignored, not mangled
        let mut bytes = f32_to_bytes(&[0.5, -0.25]);
        bytes.push(0xAB);
        assert_eq!(bytes_to_f32(&bytes), vec![0.5, -0.25]);
    }

    #[test]
    fn output_has_exactly_the_input_length_and_the_voice_stays_in_sync() {
        let sr = 48_000usize;
        let input: Vec<f32> = (0..sr * 2).map(|i| 0.3 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin()).collect();
        for cleanup in [SpeechCleanup { dereverb: true, deess: false }, SpeechCleanup { dereverb: false, deess: true }, SpeechCleanup { dereverb: true, deess: true }] {
            let mut chain = SpeechChain::new(cleanup, VoiceLevel::Normal, 1, sr as u32).unwrap();
            let out = run(&mut chain, &input, 3000);
            assert_eq!(out.len(), input.len(), "{:?}", cleanup);
            // cross-correlate a window in the middle against the input: the best lag must be 0
            let (a, b) = (&input[40_000..48_000], &out[40_000..48_000]);
            let mut best = (0i32, f32::MIN);
            for lag in -300i32..=300 {
                let mut s = 0.0;
                for i in 300..a.len() - 300 {
                    s += a[(i as i32 + lag) as usize] * b[i];
                }
                if s > best.1 {
                    best = (lag, s);
                }
            }
            assert!(best.0.abs() <= 1, "{:?} is {} samples out of sync", cleanup, best.0);
        }
    }

    #[test]
    fn the_result_does_not_depend_on_how_the_audio_is_cut_into_blocks() {
        let sr = 48_000usize;
        let mut rng = Lcg(7);
        let input: Vec<f32> = vowel(sr, 1.0, 0.15).iter().map(|v| v + 0.02 * rng.next()).collect();
        let cleanup = SpeechCleanup { dereverb: true, deess: true };
        let big = run(&mut SpeechChain::new(cleanup, VoiceLevel::Normal, 1, sr as u32).unwrap(), &input, 8192);
        let small = run(&mut SpeechChain::new(cleanup, VoiceLevel::Normal, 1, sr as u32).unwrap(), &input, 777);
        assert_eq!(big.len(), small.len());
        let worst = big.iter().zip(&small).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-3, "blocks of different size gave results {} apart", worst);
    }

    #[test]
    fn stereo_channels_are_processed_and_kept_in_order() {
        let sr = 48_000usize;
        // left = tone, right = silence
        let mut input = Vec::new();
        for i in 0..sr {
            input.push(0.3 * (2.0 * std::f32::consts::PI * 300.0 * i as f32 / sr as f32).sin());
            input.push(0.0);
        }
        let mut chain = SpeechChain::new(SpeechCleanup { dereverb: false, deess: true }, VoiceLevel::Normal, 2, sr as u32).unwrap();
        let out = run(&mut chain, &input, 4000);
        assert_eq!(out.len(), input.len());
        let right: Vec<f32> = out.iter().skip(1).step_by(2).copied().collect();
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        assert!(rms(&right) < 1e-4, "silence leaked into the other channel");
        assert!(rms(&left) > 0.1, "the tone was lost");
    }

    #[test]
    fn deesser_softens_harsh_s_and_leaves_vowels_alone() {
        let sr = 48_000usize;
        let mut rng = Lcg(3);
        // 0-1 s vowel, 1-1.5 s sibilant noise (high-passed by differencing), 1.5-3 s vowel
        let mut input = vowel(sr, 1.0, 0.12);
        let mut prev = 0.0f32;
        input.extend((0..sr / 2).map(|_| {
            let n = rng.next();
            let v = 0.35 * (n - prev);
            prev = n;
            v
        }));
        input.extend(vowel(sr, 1.5, 0.12));
        let mut chain = SpeechChain::new(SpeechCleanup { dereverb: false, deess: true }, VoiceLevel::Strong, 1, sr as u32).unwrap();
        let out = run(&mut chain, &input, 6000);
        let burst = (db(hf_rms(seg(&input, sr, 1.1, 1.4))), db(hf_rms(seg(&out, sr, 1.1, 1.4))));
        let vowel_hf = (db(hf_rms(seg(&input, sr, 0.3, 0.9))), db(hf_rms(seg(&out, sr, 0.3, 0.9))));
        let vowel_level = (db(rms(seg(&input, sr, 0.3, 0.9))), db(rms(seg(&out, sr, 0.3, 0.9))));
        println!("sibilant burst HF: {:.1} dB -> {:.1} dB; vowel HF: {:.1} -> {:.1}; vowel level: {:.1} -> {:.1}", burst.0, burst.1, vowel_hf.0, vowel_hf.1, vowel_level.0, vowel_level.1);
        assert!(burst.0 - burst.1 >= 4.0, "the harsh s was only reduced by {:.1} dB", burst.0 - burst.1);
        assert!((vowel_level.0 - vowel_level.1).abs() < 1.0, "the vowel changed level by {:.1} dB", vowel_level.0 - vowel_level.1);
        assert!((vowel_hf.0 - vowel_hf.1).abs() < 1.5, "the vowel's brightness changed by {:.1} dB", vowel_hf.0 - vowel_hf.1);
    }

    #[test]
    fn dereverb_shortens_the_room_tail_and_keeps_the_voice() {
        let sr = 16_000usize;
        let mut rng = Lcg(11);
        // dry voice: two 0.4 s phrases, at 0.2 s and 1.6 s, in 3 s of silence
        let mut dry = vec![0.0f32; sr * 3];
        for start in [0.2f32, 1.6] {
            let v = vowel(sr, 0.4, 0.2);
            for (i, s) in v.iter().enumerate() {
                let fade = (i as f32 / 800.0).min(1.0).min((v.len() - i) as f32 / 800.0);
                dry[(start * sr as f32) as usize + i] = s * fade;
            }
        }
        // a room: 600 reflections with random delays, decaying 60 dB over RT60 = 0.7 s
        let rt60 = 0.7f32;
        let taps: Vec<(usize, f32)> = (0..600)
            .map(|k| {
                let t = if k == 0 { 0.0 } else { rng.next().abs() * 0.7 };
                let gain = 10f32.powf(-3.0 * t / rt60) * rng.next() * if k == 0 { 0.0 } else { 0.3 };
                ((t * sr as f32) as usize, if k == 0 { 1.0 } else { gain })
            })
            .collect();
        let mut wet = vec![0.0f32; dry.len()];
        for (i, &x) in dry.iter().enumerate() {
            if x != 0.0 {
                for &(d, g) in &taps {
                    if i + d < wet.len() {
                        wet[i + d] += x * g;
                    }
                }
            }
        }
        let mut drops = Vec::new();
        for level in [VoiceLevel::Soft, VoiceLevel::Normal, VoiceLevel::Strong] {
            let mut chain = SpeechChain::new(SpeechCleanup { dereverb: true, deess: false }, level, 1, sr as u32).unwrap();
            let out = run(&mut chain, &wet, 4096);
            let tail = (db(rms(seg(&wet, sr, 0.75, 1.15))), db(rms(seg(&out, sr, 0.75, 1.15))));
            let voice = (db(rms(seg(&wet, sr, 0.3, 0.55))), db(rms(seg(&out, sr, 0.3, 0.55))));
            let dry_voice = db(rms(seg(&dry, sr, 0.3, 0.55)));
            println!("{:?}: room tail {:.1} -> {:.1} dB (-{:.1}); voice {:.1} -> {:.1} dB (-{:.1}); the dry voice, without the room, is {:.1} dB", level, tail.0, tail.1, tail.0 - tail.1, voice.0, voice.1, voice.0 - voice.1, dry_voice);
            drops.push((tail.0 - tail.1, voice.0 - voice.1));
        }
        // Each step up cleans the room more...
        assert!(drops[0].0 < drops[1].0 && drops[1].0 < drops[2].0, "tail reduction should grow with the level: {:?}", drops);
        // ...and at the default level the tail drops clearly more than the voice does. The gain of the voice
        // over the room (tail drop minus voice drop) measured 1.7 / 3.9 / 5.9 dB at Soft / Normal / Strong.
        // The voice's own level also falls a little (worst case here: a held synthetic vowel, which the
        // model partly mistakes for reverberation); the loudness normaliser later in the chain restores it.
        assert!(drops[1].0 >= 5.0, "default level only removed {:.1} dB of room tail", drops[1].0);
        assert!(drops[1].0 - drops[1].1 >= 3.0, "default level hurts the voice about as much as the room: {:?}", drops[1]);
    }
}
