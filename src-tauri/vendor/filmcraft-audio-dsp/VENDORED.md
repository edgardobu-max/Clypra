# Vendored from FilmCraft

This directory is a copy of `crates/audio-dsp` from https://github.com/storytold/filmcraft
(commit `a2f6ba8b444f58a744a0af0c2f5b80524d6f9726`, FilmCraft 0.2.1).

Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors. Licensed under the MIT License or the
Apache License 2.0, at your option (see `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` in this directory).
The ArtCraft name and logos are trademarks of the ArtCraft Team and are not covered by that license;
they are not used here.

The source files are unmodified. Only `Cargo.toml` was rewritten: the workspace inheritance and the
test-only dev-dependency on FilmCraft's test kit were removed so the crate builds on its own. The
integration test that needs that test kit (`tests/loudness_oracle.rs`) was not copied.

Used by `src/commands/audio_enhance.rs` for the optional "remove room echo" (DeReverb) and
"soften harsh s" (DeEsser) steps of the voice enhancement.
