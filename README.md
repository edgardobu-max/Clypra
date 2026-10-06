# MuzikaliDesk Editor

A personal video editor for short news reels, built on **[Clypra](https://github.com/AIEraDev/clypra)** (MIT, by the Clypra Contributors). It adds, among other things: audio in the export (voice-over + music mix with per-clip volume and fades), automatic subtitles from the voice-over or its script (local Whisper), branded animated titles, covers/thumbnails, Slide/Zoom/Dissolve transitions, a media bin with folders, multi-selection editing, and 9:16 / 1:1 / 16:9 export presets.

> Based on Clypra. The original license and copyright notice are kept in [`LICENSE`](LICENSE).

## Build and install (Windows)

Requirements: Node 20+, Rust, [vcpkg](https://vcpkg.io) with FFmpeg (`VCPKG_ROOT`), an FFmpeg on `PATH` (to bundle `ffmpeg.exe`/`ffprobe.exe`), and [`uv`](https://docs.astral.sh/uv/) at run time for automatic subtitles (`winget install astral-sh.uv`).

```bash
npm install
npm run build:release   # stages FFmpeg DLLs/binaries, builds the NSIS installer
# -> src-tauri/target/release/bundle/nsis/MuzikaliDesk Editor_<version>_x64-setup.exe
```

Development: `npm run tauri dev`. Tests: `npx vitest run` and `cd src-tauri && cargo test --lib`.
The project log with decisions, measurements and known limits is in [`BITACORA.md`](BITACORA.md); the upstream effects API notes are in [`docs/UPSTREAM_API.md`](docs/UPSTREAM_API.md).

---

## About the original Clypra

## Clypra

<div align="center">

![Clypra Showcase Banner](public/clypra.jpg)

![Clypra Logo](https://img.shields.io/badge/Clypra-Video%20Editor-blue?style=for-the-badge)

A modern, open-source video editor built with Tauri, React, and TypeScript featuring a professional timeline interface.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md) [![GitHub issues](https://img.shields.io/github/issues/AIEraDev/clypra)](https://github.com/AIEraDev/clypra/issues) [![GitHub stars](https://img.shields.io/github/stars/AIEraDev/clypra)](https://github.com/AIEraDev/clypra/stargazers)

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Contributing](#contributing) • [License](#license)

</div>

---

## Features

- 🎬 **Multi-Format Support** - Import MP4, MOV, WebM, MKV, M4V, AVI videos, MP3, WAV, AAC audio, and JPG, PNG, WebP images
- ✂️ **Precision Editing** - Frame-accurate trimming with visual timeline
- 📊 **Audio Visualization** - Real-time audio waveform display
- 🎞️ **Filmstrip Preview** - Thumbnail strip for easy navigation
- 🎯 **Professional Timeline** - Multi-track timeline with ruler and playhead
- 📝 **Text Overlays** - Add titles and captions with custom fonts
- 💾 **Project Management** - Save and load projects with auto-save
- ↩️ **Undo/Redo** - 100 levels of undo/redo history
- ⚡ **Fast Processing** - FFmpeg-powered video processing
- 🖥️ **Native Performance** - Built with Tauri for desktop-class performance
- 🎨 **Modern UI** - Clean, intuitive interface with dark mode
- 🔄 **Cross-Platform** - Works on macOS, Windows, and Linux

## Download & Installation

### macOS (Apple Silicon & Intel)

The recommended way to install Clypra on macOS is via **Homebrew Cask** to automatically bypass the Gatekeeper security warnings:

```bash
# Add the custom tap and install the cask
brew install AIEraDev/tap/clypra
```

Alternatively, download the direct installer from the [Latest Releases](https://github.com/AIEraDev/Clypra/releases/latest):

- **macOS Universal DMG** _(If using the DMG, drag Clypra to your `/Applications` folder, then Right-click/Control-click the icon and select **Open** to authorize execution)._

### Windows

- **Windows x64 MSI Installer**: Download from the [Latest Releases](https://github.com/AIEraDev/Clypra/releases/latest) _(If SmartScreen blocks execution, click **More Info** and select **Run Anyway**)._

### Linux

- **Linux x64 AppImage**: Download from the [Latest Releases](https://github.com/AIEraDev/Clypra/releases/latest) _(Make the file executable using `chmod +x Clypra_.AppImage`, then run).\*

## Project Structure

```
src/
├── components/          # React components
│   ├── editor/         # Core editor components (Timeline, Preview, etc.)
│   ├── screens/        # Full-screen views (LaunchScreen)
│   └── ui/             # Generic UI components (Modals, Icons, etc.)
├── store/               # Zustand global state stores
│   ├── timelineStore.ts# Timeline structure (tracks, clips)
│   ├── playbackStore.ts# Playback sync and playhead state
│   ├── projectStore.ts # Media assets and project settings
│   └── ...             # uiStore, settingsStore, dragStateStore
├── lib/                 # Shared utilities and FFmpeg logic
├── hooks/               # Custom React hooks
├── types/               # TypeScript type definitions
├── constants/           # Global configuration
└── App.tsx              # Main application entry
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation.

## Getting Started

### Prerequisites

- **Node.js** 18+ and npm
- **Rust** and Cargo (latest stable)
- **macOS desktop builds**: FFmpeg and FFprobe are bundled as **Tauri sidecars** (`src-tauri/bin/`). The checked-in files are small wrappers that call `ffmpeg` / `ffprobe` from your **`PATH`** so local `cargo tauri dev` works without copying static binaries. For release DMGs, replace them with static builds per [`src-tauri/bin/README.md`](./src-tauri/bin/README.md) (GPL/LGPL compliance, **code-signing** / notarization for sidecars). Until Linux/Windows sidecars exist, install FFmpeg on those platforms as before.

### Install FFmpeg (dev / non-macOS)

```bash
# macOS (used by sidecar wrappers until you drop in static binaries)
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows (using Chocolatey)
choco install ffmpeg

# Or download from https://ffmpeg.org/download.html
```

### Installation

```bash
# Clone the repository
git clone https://github.com/AIEraDev/clypra.git
cd clypra

# Install dependencies
npm install

# Configure API key (required for text effects and templates)
cp .env.example .env
# Edit .env and add your Clypra API key

# Run in development mode
npm run tauri dev
```

### API Configuration

Clypra uses the Clypra API for text effects and templates. To enable these features:

1. Copy the `.env.example` file to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Add your API key to the `.env` file:

   ```
   VITE_CLYPRA_API_KEY=your_api_key_here
   ```

3. **Important**: Never commit the `.env` file to version control. It's already included in `.gitignore`.

The API key is used to authenticate requests to:

- Text effects library
- Text templates library
- Lottie animations

### Building from Source

```bash
# Build the frontend
npm run build

# Build the Tauri app
npm run tauri build

# The built app will be in src-tauri/target/release/
```

## Development

### Available Scripts

- `npm run dev` - Start Vite dev server
- `npm run build` - Build frontend
- `npm run preview` - Preview production build
- `npm run tauri dev` - Run Tauri app in development
- `npm run tauri build` - Build Tauri app for production

### Tech Stack

**Frontend:**

- React 19
- TypeScript
- Tailwind CSS 4
- Vite 7

**Backend:**

- Tauri 2
- Rust
- FFmpeg (via CLI)

## Usage

1. **Import Media** - Click "Import Media" to select video, audio, or image files
2. **Preview** - Use the video player controls to preview your content
3. **Edit Timeline** - Drag media to the timeline and arrange clips
4. **Trim & Adjust** - Adjust clip start/end times using the timeline
5. **Export** - Click "Export" to save your edited video

### Keyboard Shortcuts

- `Space` - Play/Pause video
- `Ctrl/Cmd + Scroll` - Zoom timeline
- `Trackpad Pinch` - Zoom timeline

## Screenshots

![Clypra Video Editor Interface](public/home-screen.png)

## Architecture Highlights

### Global State Management (Zustand)

Clypra relies on a powerful and scalable state architecture using **Zustand**. State is split into logical domains to minimize unnecessary re-renders while ensuring high performance:

- **`timelineStore`**: Manages complex timeline manipulations (clips, tracks).
- **`playbackStore`**: Highly optimized store for frame-accurate playback and playhead sync.
- **`projectStore`**: Manages media assets, project settings, and history.
- **`uiStore`** & **`settingsStore`**: Handles application themes, view modes, and preferences.

### Clean Separation of Concerns

- **Components (`src/components`)** - Focused purely on declarative UI rendering. Core editor modules (Timeline, SourcePreview, PreviewPanel) are fully decoupled.
- **State (`src/store`)** - Centralized business logic and actions.
- **Utilities (`src/lib`)** - Pure functions for timeline math, FFmpeg process execution, and Tauri sidecar integration.
- **Type Safety (`src/types`)** - Strict TypeScript models for the entire editing domain.

### Performance Optimizations

- Memoized calculations for timeline rendering
- Canvas-based waveform for efficient visualization
- Async filmstrip generation to avoid blocking UI
- Proper cleanup to prevent memory leaks

## Contributing

We welcome contributions from the community! Whether it's:

- 🐛 Bug reports
- 💡 Feature requests
- 📝 Documentation improvements
- 🔧 Code contributions

Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before submitting a PR.

### Development

```bash
# Run tests
npm test

# Run tests with UI
npm run test:ui

# Lint code
npm run lint
```

## Roadmap

- [ ] Multi-track audio mixing
- [ ] Video effects and filters
- [ ] Transitions between clips
- [x] Text and title overlays
- [x] Export presets for different platforms
- [ ] Keyboard shortcut customization
- [ ] Plugin system

## Community

- **Discord**: [Join our Discord](https://discord.gg/clypra) _(coming soon)_
- **Issues**: [GitHub Issues](https://github.com/AIEraDev/clypra/issues)
- **Discussions**: [GitHub Discussions](https://github.com/AIEraDev/clypra/discussions)
- **Pull Requests**: [Contributing Guide](CONTRIBUTING.md)
- **Sponsor**: [GitHub Sponsors](https://github.com/sponsors/AIEraDev) _(coming soon)_

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Tauri](https://tauri.app) - Rust-powered desktop apps
- Video processing by [FFmpeg](https://ffmpeg.org)
- UI powered by [React](https://react.dev) and [Tailwind CSS](https://tailwindcss.com)
- Timeline design inspired by professional video editors

## Support

If you find this project useful, please consider:

- ⭐ Starring the repository
- 🐛 Reporting bugs
- 💡 Suggesting new features
- 🔧 Contributing code
- 📢 Sharing with others

---

<div align="center">

Made with ❤️ by the Clypra community

</div>
