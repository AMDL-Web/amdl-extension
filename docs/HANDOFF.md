# Technical Handoff & Verified Research

This document carries over every verified technical finding, benchmark, pitfall, and reference path established during the browser-pipeline experiments in `/home/lyjw/Projects/apple-music-downloader` (branch `exp/browser-pipeline`).

## 1. Product Requirements (v1 — Chrome MV3 Extension)

1. **Target surface**: Chrome Manifest V3 extension running directly against `https://music.apple.com/*`.
2. **In-page UI**: Inject native-feeling download buttons into `music.apple.com` (track rows, song/album headers, plus an extension popup/options panel for settings and download queue/progress).
3. **Two operating modes**:
   - **No wrapper configured (default / zero-config)**:
     - Download 256 kbps `aac-lc` directly using the user's logged-in `music.apple.com` session (`media-user-token` + Web JWT), Widevine L3 software decryption, pure-client fMP4→M4A flattening, and metadata/cover/lyrics tagging.
   - **Wrapper configured** (e.g. `http://wrapper.lan`, with optional Bearer token):
     - Unlock quality & codec settings: `alac` (with `maxSampleRate` / `maxBitDepth`), `aac`, `aac-binaural`, `aac-downmix`, `ec3` (Dolby Atmos), `ac3`, and `aac-lc` (selectable or fallback).
     - Use wrapper for `/m3u8` (Hi-Res ALAC > 48 kHz), `/key` (FairPlay templates), `/lyrics` (fallback), and `/status` (health/region check).
4. **Local test environment**:
   - Wrapper endpoint: `http://wrapper.lan` (wrapper-manager serving `cn` and `jp` accounts).
   - License: AGPL-3.0 (`LICENSE`).
   - GitHub remote: lyjw will create a private GitHub repository and attach `origin`.

## 2. Why Chrome MV3 Eliminates the Need for a Proxy Server

Earlier web-app experiments required a local CORS/header proxy because a third-party origin cannot read `music.apple.com` JS or forge `Origin: https://music.apple.com` for `amp-api.music.apple.com`. Inside a Chrome extension operating directly on `https://music.apple.com`:

| Target | Verified Behavior | Chrome MV3 Strategy |
| --- | --- | --- |
| `music.apple.com` session | Holds user login (`media-user-token`) & scraped Web JWT | Read directly from `music.apple.com` context (verify best mechanism on live page: `MusicKit.getInstance()`, cookies via `chrome.cookies`, or page fetch hook) |
| `amp-api.music.apple.com` | Requires Web JWT + `Origin: https://music.apple.com` (returns `401` on third-party `Origin`) | Same-site from `music.apple.com` page context, or from extension background with `declarativeNetRequest` setting `Origin` / `Referer` |
| `play.music.apple.com` / `play.itunes.apple.com` | WebPlayback (`webPlayback`, `acquireWebPlaybackLicense`) requires Web JWT + `X-Apple-Music-User-Token`; live probe showed dynamic `Origin` reflection and preflight allowing `authorization, content-type, x-apple-music-user-token` | Verify full end-to-end call with live logged-in `music.apple.com` token |
| `aod.itunes.apple.com` (`.m3u8` & encrypted `.mp4`) | Verified `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: range`, `Access-Control-Expose-Headers: *` on both ALAC 24/96 (87.7 MB) and AAC (8.3 MB) `GET`/`Range`/`OPTIONS` | Direct `fetch` + ranged parallel downloads (no proxy) |
| `*.mzstatic.com` (artwork) | Verified `Access-Control-Allow-Origin: *` | Direct `fetch` |
| Local `http://wrapper.lan` | No CORS headers; HTTPS `music.apple.com` content script hits Mixed Content / Private Network Access | Route wrapper HTTP calls through the extension **background Service Worker** with host permissions (e.g. `http://*/*` / optional host permission granted for the user's wrapper origin) |

## 3. Core Architecture & Verified Benchmarks

### 3.1 FairPlay Decryption: Rust `temari-wasm` + Web Worker Pool (Do NOT Bundle Full Go Wasm)

From head-to-head V8 benchmarks (AMD Ryzen 9 9900X, Node v26 / V8 14.6, golden vector `track_1720704575_s1`, 9,354 B):

| Implementation | Throughput (single) | Multi-worker (96 MiB, 16 KiB samples) | Wasm Size (raw / gzip) |
| --- | ---: | ---: | ---: |
| Native Go (`internal/fairplay`) | 121–123 MB/s | — | — |
| Native Rust (`Temari` cdylib via purego) | 104.7 MB/s | — | — |
| Go → wasm (`internal/fairplay` only) | 45.0 MB/s | Single-threaded only | 4.4 MiB / 1.20 MiB |
| Go → wasm (full `amdl.wasm` w/ Widevine) | 45.0 MB/s | Single-threaded only | 20.0 MiB / 4.62 MiB |
| **Rust → wasm (upstream `Temari v0.5.1`)** | **55.9 MB/s (1.24×; 1.30–1.39× w/ JS copy)** | **2W: 110 MB/s · 8W: 419.8 MB/s (238 ms / 100 MB)** | **109 KiB / 34.9 KiB** |

**Key findings about upstream `github.com/WorldObservationLog/Temari` (MIT, tag `bindings/go/v0.5.1`, commit `85c6762`):**
- Core crate is pure `std` with **zero third-party dependencies** (`src/rounds_gen.rs`, `src/rounds.rs`, `src/template.rs`).
- Compiles directly to `wasm32-unknown-unknown` with `opt-level = 3, lto = true, codegen-units = 1, panic = "abort", strip = true` in ~1.3 s (Docker `rust:1.85-slim` is already cached on this machine; host does not have `rustc` installed directly).
- **CRITICAL PITFALL — Do NOT copy upstream `bindings/wasm/temari.js`**:
  1. It uses a JS bump allocator starting at `0x80000` that **never reclaims memory** (`2 × sample_len` leaked permanently per `decrypt()` call — 200 MB leaked on a single 100 MB ALAC track) and risks colliding with Rust's own internal allocator (`dlmalloc`).
  2. Upstream `decrypt_sample_ffi` allocates a fresh `Vec` and copies on every call; instead export `wasm_alloc`, `wasm_dealloc`, and zero-alloc `decrypt_region_into` / batch sample decryption.
  3. Temari's 2-lane ILP (`decrypt_region_pair_into`) is ~3.5% slower in Wasm (53.8 vs 55.9 MB/s) due to register pressure; stick to single-lane inside each Worker.
- **MV3 execution note**:
  - MV3 Service Workers cannot spawn classic `new Worker()` and terminate after ~30 s idle.
  - Run the Web Worker Pool (with Transferable `ArrayBuffer` — **no `SharedArrayBuffer` / COOP / COEP needed**) inside an **Offscreen Document** (`chrome.offscreen`) or an extension page, and add `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }` to `manifest.json`.

### 3.2 Widevine L3 (`aac-lc`) Software Decryption

- Browser built-in EME is a black box and cannot expose plaintext keys or audio bytes; `aac-lc` requires a software Widevine L3 CDM + CENC (`SAMPLE-AES-CTR`) decryptor.
- Protocol verified end-to-end in `experiments/browser/engine/aaclc.go`:
  1. `POST https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback` with `{"salableAdamId": "<id>"}` + Web JWT + `X-Apple-Music-User-Token` → read `hls-playlist-url` (or asset with flavor `28:ctrp256`).
  2. Parse AAC-LC `.m3u8`: `#EXT-X-KEY` URI holds base64 `KID` after comma; `#EXT-X-MAP` holds encrypted `.mp4` URI.
  3. Build Widevine PSSH box (`systemID = edef8ba979d64acea3c827dcd51d21ed`, protobuf `WidevinePsshData{KeyIds: [kid]}`), generate L3 license challenge using the embedded L3 `.wvd` device (see `internal/media/widevine_device.go`).
  4. `POST https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense` with `{challenge, uri, "key-system": "com.widevine.alpha", adamId, isLibrary: false, "user-initiated": true}` + Web JWT + `X-Apple-Music-User-Token` → receive base64 `license`.
  5. Parse license to extract AES-128 content key, decrypt CENC fMP4 samples (AES-128-CTR per subsample/sample).
- In the Go wasm experiment, `gowidevine` decrypted an 8.5 MiB AAC-LC track in **59 ms** (~152.5 MB/s) and produced an M4A that Chromium `<audio>` played natively (`readyState=4`, `duration=252.07 s`).
- For a lightweight Chrome extension, implement Widevine L3 + CENC either as a small Rust/TS crypto module (WebCrypto + RSA-OAEP/PSS + CMAC/AES-CBC + AES-CTR + minimal protobuf) or a lazy-loaded small Rust wasm crate — avoid shipping a 20 MiB Go binary.

### 3.3 Pure-Client fMP4 → Progressive M4A Flattening & iTunes Tagging (No `ffmpeg`)

- Proven in `/home/lyjw/Projects/apple-music-downloader/experiments/browser/m4a/` (~1,480 lines of Go: `box.go`, `flatten.go`, `tags.go`):
  - Writes `ftyp` (`M4A ` / `iso2mp41`), `mdat`, and trailing `moov` with reconstructed `stts`, `ctts`, `stsc`, `stsz`, `stco`/`co64`, `elst`, AAC `sgpd`/`sbgp` pre-roll (`roll`), and `moov/udta/meta/ilst` (including creating `udta/meta/ilst` when missing, which AAC-LC WebPlayback assets lack).
  - Handles `(E-)AC-3` final sample duration padding (`padLastDuration`) and AAC `elst` encoder-delay preservation so decoded PCM matches `ffmpeg -c copy` bit-for-bit.
  - Verified byte/PCM identical to `ffmpeg` across ALAC 16/44.1, ALAC 24/96, AAC, AAC with edit list, E-AC-3 Atmos, and AC-3.
- **Recommended implementation**: Port `experiments/browser/m4a/` 1:1 to zero-dependency TypeScript (`DataView` / `Uint8Array`) with **streaming chunk assembly** (`BlobPart[]` or `FileSystemWritableFileStream`) so peak memory drops from ~3× track size to ~1.2×.

## 4. Reference Paths in `/home/lyjw/Projects/apple-music-downloader` (Read-Only)

Switch or read via `git show exp/browser-pipeline:<path>` (branch `exp/browser-pipeline`, commits `3e66b6ff` and `3bcb2333`):
- `experiments/browser/REPORT.md` — Full report & 10-track E2E matrix
- `experiments/browser/archive/e2e-matrix.json` — Raw timings, sizes, SHA-256, PCM MD5 across all 10 tracks
- `experiments/browser/m4a/{box.go,flatten.go,tags.go,ref_test.go}` — Pure fMP4 flattener, iTunes tagger, and `ffmpeg` comparison tests
- `experiments/browser/engine/{engine.go,hls.go,decrypt.go,aaclc.go,lyrics.go,song.go,transfer.go}` — Complete per-track pipeline logic

On `dev` / working tree of `/home/lyjw/Projects/apple-music-downloader`:
- `internal/applemusic/playback.go` — `WebPlayback`, `License`, `SongLyrics`, `AccountStorefront`
- `internal/applemusic/catalog.go` & `url.go` — URL parsing, web JWT scraping, catalog queries
- `internal/media/aaclc.go` & `widevine_device.go` — Widevine L3 session & embedded test `.wvd`
- `internal/media/hls.go` — Master/media playlist parsing & codec selection patterns (`c23`/`c22`/`c24`/`c6` key suffixes, `prefetchKey = "skd://itunes.apple.com/P000000000/s1/e1"`)
- `internal/wrapper/media.go` & `client.go` — Wrapper API contract (`/status`, `/m3u8`, `/key`, `/lyrics`, `/webplayback`, `/license`)
- `internal/fairplay/testdata/track_1720704575_s1.{json,ct,pt}` — MIT-licensed golden FairPlay test vector
- `.ryugi/artifacts/document/browser-lite-plan/doc.xml` — Earlier web-app architecture plan (superseded by Chrome MV3 extension for v1)

## 5. Verified Test Track Matrix (All 10 Verified Previously)

| # | URL | Track (Storefront) | Codec / Feature |
| ---: | --- | --- | --- |
| 1 | `https://music.apple.com/cn/album/1580904295?i=1580904297` | ReoNa — 生命線 (`cn`) | Hi-Res ALAC 24/96 (device `/m3u8`), lyrics |
| 2 | `https://music.apple.com/cn/album/1576634760?i=1576635258` | James Harris — EMIYA #LEGACY (`cn`) | ALAC 16/44.1, no lyrics |
| 3 | `https://music.apple.com/cn/song/1783644604` | MyGO!!!!! — 迷星叫 (`cn`) | FairPlay AAC 48 kHz, lyrics |
| 4 | `https://music.apple.com/jp/album/1760452190?i=1760452193` | 星街すいせい — ビビデバ (`jp`) | ALAC 24/48, lyrics |
| 5 | `https://music.apple.com/jp/album/1585332601?i=1585332602` | 星街すいせい — Stellar Stellar (`jp`) | Dolby Atmos `ec3` (6 ch) + `aac-binaural` + `aac-downmix` |
| 6 | `https://music.apple.com/jp/album/1648881903?i=1648882048` | ヨルシカ — 夏陰、ピアノを弾く (`jp`) | Widevine `aac-lc` 44.1 kHz, short 94 s instrumental |
| 7 | `https://music.apple.com/us/album/1650841512?i=1650841513` | Taylor Swift — Lavender Haze (`us`) | Cross-region `us` Dolby Atmos `ec3` |
| 8 | `https://music.apple.com/cn/song/1538278601` | Miku Sawai — I Know (`cn`) | ALAC 16/44.1, small track, no lyrics |
| 9 | `https://music.apple.com/cn/song/1542953977` | Utada — One Last Kiss (`cn`) | Hi-Res ALAC 24/96 (88 MB) & Widevine `aac-lc` (8.5 MB) |
