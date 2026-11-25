# amdl-extension

Chrome Manifest V3 extension that injects download controls directly into `https://music.apple.com`:
- **Without wrapper configured**: downloads 256 kbps `aac-lc` directly using the user's logged-in Apple Music web session (Widevine L3 software CDM + pure-client MP4 flatten & tag).
- **With wrapper configured** (e.g. local `http://wrapper.lan`): unlocks codec/quality selection (`alac` with max sample rate / bit depth, `aac`, `aac-binaural`, `aac-downmix`, `ec3`, `ac3`, `aac-lc` fallback) using multi-worker Rust `temari-wasm` FairPlay decryption.

Read [docs/HANDOFF.md](docs/HANDOFF.md) first before designing or writing code — it holds all verified findings, benchmarks, pitfalls, test tracks, and reference paths from the prior experiments in `/home/lyjw/Projects/apple-music-downloader`.

## Conventions

- Repository content (code, comments, docs, commit messages) is English; communicate with lyjw in Simplified Chinese.
- Commits follow Conventional Commits (`type(scope): summary`), preserving the user's git identity and signing settings.
- License is **AGPL-3.0** (`LICENSE`). Third-party code integrated from `Temari` is MIT-licensed (preserve attribution).
- Never hardcode, log, or persist secrets (`media-user-token`, `Authorization`, `X-Apple-*`, wrapper bearer tokens) in console logs or committed files.
- Use `http://wrapper.lan` as the local wrapper test target (wrapper-manager with `cn` and `jp` accounts); never modify `~/Music/AMDL` or `~/.config/AMDL`.
- Validate generated `.m4a` outputs against `ffmpeg -v error -i <file> -f null -` and `ffprobe` (audio stream, duration, tags, embedded cover & lyrics).
