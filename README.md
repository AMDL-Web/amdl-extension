# amdl-extension

A lightweight Chrome (Manifest V3) extension that integrates directly into `https://music.apple.com` to download Apple Music tracks and albums in the browser — without running a separate local proxy or backend.

## Planned Capabilities

- **In-page download controls on `music.apple.com`**: inject download buttons directly on song/album pages and track rows, with status feedback and audio tagging (metadata, lyrics, cover art).
- **Zero-config AAC-LC mode (no wrapper required)**: automatically reuses the user's logged-in Apple Music web session to download 256 kbps AAC-LC via Widevine L3 + pure-client fMP4 remux & tagging.
- **Optional Wrapper mode (full quality unlocked)**: configure a wrapper endpoint (such as `http://wrapper.lan` with optional Bearer token) to unlock quality/codec selection (`alac` up to 24-bit / 192 kHz, `aac`, `aac-binaural`, `aac-downmix`, `ec3` Dolby Atmos, `ac3`, and `aac-lc` fallback) powered by multi-worker Rust `temari-wasm` FairPlay decryption.

## Status

Project scaffolded and handed off for implementation. See [docs/HANDOFF.md](docs/HANDOFF.md) for the complete technical research, benchmark baselines, protocol notes, and implementation roadmap carried over from the `apple-music-downloader` browser experiments.

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
