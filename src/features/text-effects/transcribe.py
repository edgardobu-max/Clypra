# /// script
# dependencies = [
#     "faster-whisper",
# ]
# ///
"""Speech-to-text for auto captions.

Usage: uv run transcribe.py <audio_path> [language] [model]

Prints one JSON object on stdout: {"text", "language", "segments": [{"start","end","text"}]}.
Errors go to stderr as {"error": ...} with exit code 1.

faster-whisper (CTranslate2) runs ~4x faster than openai-whisper on CPU and the
`small` model is far more accurate in Spanish than `tiny`. The model is
downloaded once on first use and cached by Hugging Face.
"""
import json
import os
import subprocess
import sys
import warnings

warnings.filterwarnings("ignore")


def load_audio(path):
    """Decode to 16 kHz mono float32 with ffmpeg.

    faster-whisper's own decoder (PyAV) fails on some builds with
    "open() got an unexpected keyword argument 'metadata_errors'"; ffmpeg is
    already required by the app, so use it and hand over a numpy array.
    """
    import numpy as np

    proc = subprocess.run(
        [os.environ.get("FFMPEG_PATH", "ffmpeg"), "-v", "error", "-nostdin", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg could not decode audio: " + proc.stderr.decode("utf-8", "replace")[:300])
    return np.frombuffer(proc.stdout, dtype=np.float32)


def chunk_words(words, max_chars=38, max_seconds=3.0):
    """Group word timings into short, readable caption lines (reels style)."""
    chunks, cur = [], []

    def flush():
        if cur:
            chunks.append({"start": cur[0].start, "end": cur[-1].end, "text": "".join(w.word for w in cur).strip()})
            cur.clear()

    for w in words:
        cur.append(w)
        text = "".join(x.word for x in cur).strip()
        ends_sentence = w.word.strip().endswith((".", "?", "!", ",", ";", ":"))
        if len(text) >= max_chars or (cur[-1].end - cur[0].start) >= max_seconds or (ends_sentence and len(text) >= 18):
            flush()
    flush()
    # Avoid a one-word orphan line at the end of a sentence.
    if len(chunks) > 1 and len(chunks[-1]["text"]) < 12 and len(chunks[-2]["text"]) + len(chunks[-1]["text"]) < 56:
        last = chunks.pop()
        chunks[-1]["end"] = last["end"]
        chunks[-1]["text"] += " " + last["text"]
    return chunks


def main():
    # The Rust side reads stdout as UTF-8; Windows pipes default to the ANSI codepage.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio path provided"}), file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ("", "auto") else None
    model_name = sys.argv[3] if len(sys.argv) > 3 else "small"

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments_iter, info = model.transcribe(
            load_audio(audio_path),
            language=language,
            task="transcribe",
            vad_filter=True,  # skip silence/music-only stretches
            beam_size=5,
            word_timestamps=True,
        )

        segments = []
        for s in segments_iter:
            if not s.text.strip():
                continue
            if s.words:
                segments.extend(chunk_words(s.words))
            else:
                segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})

        print(
            json.dumps(
                {
                    "text": " ".join(s["text"] for s in segments),
                    "language": info.language,
                    "segments": segments,
                },
                ensure_ascii=False,
            )
        )
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
