# amdl-extension

A lightweight Chrome (Manifest V3) extension that integrates directly into `https://music.apple.com` to download Apple Music tracks and albums in the browser — with no local proxy or `ffmpeg` required.

## Features

- **In-page controls on `music.apple.com`**: injects Shadow-DOM-isolated download buttons into album headers, song headers, and individual track rows with live progress rings, completion badges, and retry states.
- **Zero-config AAC-LC mode (default)**: works out of the box when signed in to `music.apple.com`. Uses your browser session (`MusicKit` / `media-user-token`) + pure-TypeScript Widevine L3 CDM & CENC AES-128-CTR on WebCrypto + pure-TypeScript fMP4→M4A flattening & iTunes tagging to download 256 kbps AAC-LC tracks.
- **Optional Wrapper mode (full quality unlocked)**: configure a wrapper endpoint (e.g. `http://wrapper.lan`, with optional Bearer token) in Extension Options to unlock codec/quality selection (`alac` up to 24-bit/192 kHz, `aac`, `aac-binaural`, `aac-downmix`, `ec3` Dolby Atmos, `ac3`, and `aac-lc` fallback), powered by a multi-worker Rust `temari-wasm` (66 KiB) FairPlay decryptor pool.
- **Rich metadata & naming**: embeds iTunes tags (`©nam`, `©ART`, `©alb`, `aART`, `©wrt`, `trkn`, `disk`, `rtng`, `plID`, `atID`, `----` custom tags), cover art (`covr`), and line- or word-timed LRC lyrics (`©lyr`, with optional translation/pronunciation) with customizable filename templates.
- **Extension popup & options**: inspect active/queued downloads, cancel or retry individual jobs, test wrapper connectivity & regions, and tune quality, lyrics, cover, concurrency, and filename templates.

## Build & Load Unpacked

```bash
pnpm install
pnpm build
```

1. Open `chrome://extensions` in Chromium / Google Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the generated `dist/` directory.

Rebuilding the committed `src/wasm/temari.wasm` (optional — only needed if modifying `crates/temari-wasm`):

```bash
pnpm build:wasm
```

Requires either a local Rust toolchain with `wasm32-unknown-unknown` or Docker (`rust:1.85-slim`).

## Usage

### Zero-config (No Wrapper)

1. Sign in to `https://music.apple.com`.
2. Navigate to any album or song page.
3. Click **Download** (header) or the circular download icon on any track row.
4. Track progress in the row badge or the extension popup; files save directly via Chrome's download manager.

### Wrapper Mode (ALAC / Atmos / FairPlay)

1. Open the extension's **Options** page (via popup ⚙ button or `chrome://extensions`).
2. Enter your **Wrapper URL** (e.g. `http://wrapper.lan`) and optional **Bearer Token**.
3. Click **Test connection** and approve the host permission prompt for that wrapper origin.
4. Select your preferred codec (`ALAC`, `AAC`, `Dolby Atmos`, etc.), ALAC caps, lyrics/cover preferences, and click **Save Settings**.

## Development & Tests

```bash
pnpm typecheck
pnpm test
pnpm build
```

### Node Reference CLI

The chrome-free `src/core/` pipeline can also be invoked directly from Node (v22.18+ / v26+) for verification against a wrapper:

```bash
node scripts/cli.ts \
  --id "https://music.apple.com/cn/album/1580904295?i=1580904297" \
  --codec alac \
  --wrapper http://wrapper.lan \
  --out /tmp/amdl-ts-cli
```

## Architecture & Privacy Notes

- See [docs/DESIGN.md](docs/DESIGN.md) and [docs/HANDOFF.md](docs/HANDOFF.md) for the full architecture, transport verification, and benchmarks.
- Apple session tokens (`developerToken`, `media-user-token`) are held strictly in offscreen memory and are never logged or persisted to storage.
- Optional wrapper bearer tokens are stored only in `chrome.storage.local` (never `chrome.storage.sync`).

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

Third-party attributions:
- Vendored FairPlay round-chain core in `crates/temari-wasm` from `github.com/WorldObservationLog/Temari` (`bindings/go@v0.5.1`, MIT License — see `third_party/temari/LICENSE`).
- Widevine L3 CDM / WVD protocol port in `src/core/widevine/` adapted from `github.com/iyear/gowidevine` (`v0.1.3`, GPL-3.0).
