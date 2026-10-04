# /// script
# dependencies = [
#     "faster-whisper",
# ]
# ///
"""Speech-to-text for auto captions.

Usage: uv run transcribe.py <audio_path> [language] [model] [script_file]

Prints one JSON object on stdout: {"text", "language", "segments": [{"start","end","text"}]}.
When a script file is given, the caption text comes from the script and only the
timing comes from the audio ("aligned": true, "matchedRatio": share of script
words that were found in the recognised speech).
Errors go to stderr as {"error": ...} with exit code 1.

faster-whisper (CTranslate2) runs ~4x faster than openai-whisper on CPU and the
`small` model is far more accurate in Spanish than `tiny`. The model is
downloaded once on first use and cached by Hugging Face.
"""
import difflib
import json
import os
import re
import subprocess
import sys
import unicodedata
import warnings
from types import SimpleNamespace

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


def _norm(token):
    """Lowercase, accent-free, alphanumeric-only form used to compare words."""
    t = unicodedata.normalize("NFD", token.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^0-9a-z]", "", t)


def align_script(script_text, words):
    """Give every word of `script_text` a start/end taken from the recognised `words`.

    Words are matched by position with difflib, so a name the recogniser got wrong
    still lines up through the correct words around it. Unmatched script words are
    spread over the time gap between their matched neighbours.
    Returns (word objects with .word/.start/.end, matched_ratio).
    """
    script_tokens = script_text.split()
    if not script_tokens or not words:
        return [], 0.0

    heard = [_norm(w.word) for w in words]
    wanted = [_norm(t) for t in script_tokens]
    starts = [None] * len(script_tokens)
    ends = [None] * len(script_tokens)
    matched = 0

    matcher = difflib.SequenceMatcher(None, heard, wanted, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                starts[j1 + k], ends[j1 + k] = words[i1 + k].start, words[i1 + k].end
            matched += j2 - j1
        elif tag == "replace":
            # Different wording over the same stretch of audio: share its time span by word length.
            t0, t1 = words[i1].start, words[i2 - 1].end
            weights = [max(1, len(wanted[j])) for j in range(j1, j2)]
            total, acc = float(sum(weights)), 0.0
            for j, wt in zip(range(j1, j2), weights):
                starts[j] = t0 + (t1 - t0) * acc / total
                acc += wt
                ends[j] = t0 + (t1 - t0) * acc / total

    # Fill the remaining runs (script words with nothing heard) between known neighbours.
    audio_start, audio_end = words[0].start, words[-1].end
    j = 0
    while j < len(script_tokens):
        if starts[j] is not None:
            j += 1
            continue
        k = j
        while k < len(script_tokens) and starts[k] is None:
            k += 1
        t0 = ends[j - 1] if j > 0 else audio_start
        t1 = starts[k] if k < len(script_tokens) else audio_end
        t1 = max(t1, t0)
        weights = [max(1, len(wanted[m])) for m in range(j, k)]
        total, acc = float(sum(weights)), 0.0
        for m, wt in zip(range(j, k), weights):
            starts[m] = t0 + (t1 - t0) * acc / total
            acc += wt
            ends[m] = t0 + (t1 - t0) * acc / total
        j = k

    # Keep time strictly moving forward.
    last_end = 0.0
    out = []
    for token, st, en in zip(script_tokens, starts, ends):
        st = max(st, last_end)
        en = max(en, st)
        out.append(SimpleNamespace(word=" " + token, start=st, end=en))
        last_end = en
    return out, matched / len(script_tokens)


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
    model_name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "small"
    script_path = sys.argv[4] if len(sys.argv) > 4 else None

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

        heard_words = []
        segments = []
        for s in segments_iter:
            if not s.text.strip():
                continue
            heard_words.extend(s.words or [])
            if s.words:
                segments.extend(chunk_words(s.words))
            else:
                segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})

        aligned, matched_ratio = False, None
        if script_path and os.path.exists(script_path):
            with open(script_path, encoding="utf-8") as f:
                script_text = f.read()
            script_words, matched_ratio = align_script(script_text, heard_words)
            if script_words:
                segments = chunk_words(script_words)
                aligned = True

        print(
            json.dumps(
                {
                    "text": " ".join(s["text"] for s in segments),
                    "language": info.language,
                    "aligned": aligned,
                    "matchedRatio": matched_ratio,
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
