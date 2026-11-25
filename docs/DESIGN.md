# amdl-extension — v1 Technical Design

Status: approved plan for the first implementation. Read [HANDOFF.md](HANDOFF.md) first; this document only records the
decisions built on top of it. Reference code lives read-only in `/home/lyjw/Projects/apple-music-downloader`
(branch `exp/browser-pipeline` for `experiments/browser/**`, working tree for `internal/**`).

## 0. Verified on the live site (2026-11-25, logged-out T3 preview)

- `MusicKit.getInstance()` exists in the page's MAIN world and exposes `developerToken` (268-char web JWT),
  `musicUserToken` (empty when logged out), `isAuthorized`, `storefrontId`.
- A page-origin `fetch` to `amp-api.music.apple.com/v1/catalog/cn/songs/<id>?extend=extendedAssetUrls` with that JWT
  returns `200` and carries `extendedAssetUrls.enhancedHls`.
- Stable DOM anchors: `[data-testid="container-detail-header"]`, `.primary-actions` (album/song header buttons),
  `[data-testid="tracklist"]`, `[data-testid="track-list-item"]` (has `data-row` = 0-based row index and
  `aria-label` = title), `[data-testid="track-column-controls"]`, `[data-testid="track-number"]`.
- `http://wrapper.lan/status` answers `{"code":0,"data":{"ready":true,"regions":["cn","jp"],"instances":[...]}}`
  with no CORS headers.
- Not yet verified live: `webPlayback` / `acquireWebPlaybackLicense` with a browser `media-user-token` (needs a
  logged-in session; production amdl uses the same calls in `internal/applemusic/playback.go`).
- **M0 spike verified (2026-11-25, throwaway Chromium 155.0.8059.84, `--headless=new`):**
  - **(a) DNR `Origin`/`Referer` rewrite on offscreen `fetch`**: `declarativeNetRequestWithHostAccess` session rule
    rewriting `Origin: https://music.apple.com` + `Referer: https://music.apple.com/` for `initiatorDomains: [<extId>]`
    applies to offscreen fetches to `amp-api.music.apple.com` — returned **200** with `extendedAssetUrls.enhancedHls`
    (control check with rule disabled returned **401**). Selected primary transport: direct offscreen `fetch` + DNR.
  - **(b) Wrapper `http://wrapper.lan/status` from offscreen**: blocked without host permission (`TypeError: Failed to
    fetch`), succeeded (**200**, `ready: true`, `regions: ["cn", "jp"]`) from both offscreen and SW once
    `http://wrapper.lan/*` host permission is present (no mixed-content or PNA block). Selected primary transport:
    direct `WrapperClient` in offscreen with `optional_host_permissions` granted per wrapper origin.
  - **(c) Offscreen `Worker` + `temari.wasm`**: classic `new Worker()` in offscreen instantiated `temari.wasm`
    (67,351 B) under CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` and decrypted Temari golden vector
    `track_1720704575_s1` (9,354 B) byte-for-byte identically to `.pt`.
  - Note: `decrypt_samples` export takes `(handle, buf_ptr, buf_len, table_ptr, count) -> i32` (adding `buf_len` for
    strict bounds checking inside Rust).

## 1. Component layout

```
music.apple.com tab                        extension
┌───────────────────────────┐   runtime   ┌──────────────────────┐  create/keep  ┌─────────────────────────────────┐
│ content/main-world.ts     │  messages   │ background/sw.ts     │──────────────▶│ offscreen/offscreen.html (+ts)  │
│  reads MusicKit tokens    │────────────▶│  router, DNR rules,  │◀──────────────│  JobQueue + Pipeline            │
│ content/inject.ts         │◀────────────│  chrome.downloads,   │   progress    │  AppleApi / WrapperClient       │
│  buttons, row badges      │  progress   │  token refresh relay │               │  WidevineCdm (WebCrypto)        │
└───────────────────────────┘             └──────────────────────┘               │  FairPlayPool ─▶ N × worker     │
        popup/ options/  ◀── runtime messages / chrome.storage ──▶                │     (temari.wasm, 109 KiB)      │
                                                                                  └─────────────────────────────────┘
```

- **Service worker** is a thin, restart-safe router. It owns no job state: it creates the offscreen document
  (`reasons: ["WORKERS", "BLOBS"]`), installs DNR session rules, relays progress to the originating tab, and calls
  `chrome.downloads.download`.
- **Offscreen document** owns the job queue, all network I/O, crypto and muxing. It survives SW suspension and can
  spawn classic `Worker`s. Only `chrome.runtime` messaging is available there; it never touches storage directly
  (settings arrive with each job / settings-changed message).
- **Content scripts**: `main-world.ts` (`world: "MAIN"`, `run_at: document_start`) answers token requests over
  `window.postMessage` with a per-load random nonce; `inject.ts` (isolated world) renders UI and talks to the SW.
- **`src/core/**` is chrome-free** (only `fetch`, WebCrypto, `DataView`), so the same pipeline runs in Node for tests
  and the reference CLI (§8).

## 2. Apple session & request transport

**Tokens.** `inject.ts` asks `main-world.ts` for `{developerToken, musicUserToken, storefrontId, language}` when a job
is enqueued. They travel with the enqueue message and live only in offscreen memory (`Map`, never
`chrome.storage`, never logged; logging helpers redact `Authorization`, `media-user-token`,
`X-Apple-Music-User-Token`, `challenge`, `license`). Fallbacks, in order:
1. `media-user-token` cookie via `chrome.cookies.get({url: "https://music.apple.com", name: "media-user-token"})`.
2. Web JWT scraped from `https://music.apple.com` → `/assets/index~*.js` (regex as `internal/applemusic/auth.go`).
On `401` from Apple, the offscreen asks the SW to refresh tokens from any open `music.apple.com` tab, then retries once.

**Transport.** `AppleApi` (amp-api, `webPlayback`, `acquireWebPlaybackLicense`, `syllable-lyrics`, `/v1/me/storefront`)
runs in the offscreen document. Apple rejects foreign `Origin`s, so the SW installs `declarativeNetRequest` session
rules that set `Origin: https://music.apple.com` and `Referer: https://music.apple.com/` for
`requestDomains: [amp-api.music.apple.com, play.music.apple.com, play.itunes.apple.com]`,
`initiatorDomains: [<extension id>]`, `resourceTypes: [xmlhttprequest]`. Host permissions make these fetches
CORS-exempt. `AppleTransport` is an interface; if milestone M0 shows DNR is not applied to offscreen requests, the
fallback implementation relays the same request through `inject.ts` (content-script fetches use the page origin,
which already works — verified above).

`aod.itunes.apple.com` and `*.mzstatic.com` are fetched directly (ACAO `*`).

## 3. Wrapper access

- Wrapper calls (`/status`, `/m3u8`, `/key`, `/lyrics`, `/webplayback`, `/license`) run from the offscreen document
  (extension origin, CORS-exempt with host permission; not subject to the HTTPS page's mixed content / PNA rules).
  If M0 shows Chrome blocks `http://` from the offscreen page, move `WrapperClient` behind an SW message relay.
- Permission: `optional_host_permissions: ["http://*/*", "https://*/*"]`; the options page requests exactly
  `<wrapper origin>/*` when the user saves the URL. Address normalisation as `wrapper.NormalizeAddress`.
- Envelope `{code, msg, data}`; non-zero `code` → `WrapperError{endpoint, code, msg}`. Bearer token sent only when set.
- Concurrency: at most 2 in-flight `/key` + `/m3u8` (wrapper-lite serialises them), 4 data calls; `/key` retries after
  1 s / 2 s / 4 s on 5xx/network errors only. Template cache per key URI (LRU 64); the prefetch key
  `skd://itunes.apple.com/P000000000/s1/e1` is fetched with `adamId=0` and pinned.
- Wrapper bearer token is stored in `chrome.storage.local` (never `sync`), shown masked in options.

## 4. Pipeline (per track, `src/core/pipeline.ts`)

Port of `experiments/browser/engine/engine.go` `Run`:

1. **Resolve**: `songs/<id>?include=albums,artists&extend=extendedAssetUrls&l=<lang>`, then the album
   (`include=tracks,artists,record-labels`, all track pages) for album-level tags and `albumSongNumbers`.
2. **Mode**: no wrapper → codec forced to `aac-lc` (requires `musicUserToken`; otherwise fail with a "sign in" error).
   Wrapper → user codec; on `codecNotFound` optionally fall back `requested → aac → aac-lc`.
3. **Manifest**
   - FairPlay codecs: device manifest from wrapper `/m3u8` when `wantsDeviceManifest` (hi-res ALAC and cap > 48 kHz),
     else catalog `enhancedHls`; `parseMaster` / `selectVariant` / `parseMedia` ported 1:1 from `engine/hls.go`
     (codec regexes, key suffixes `c23/c22/c24/c6`, `keys[0] = prefetchKey`).
   - `aac-lc`: `webPlayback` → `hls-playlist-url` (or asset flavor `28:ctrp256`) → `#EXT-X-KEY` URI (KID after the
     comma) + `#EXT-X-MAP`. With a wrapper configured, `webPlayback`/`license` fall back to wrapper `/webplayback`
     and `/license` when Apple rejects the user token (as `engine/aaclc.go`).
4. **Overlap**: start key/template fetch (FairPlay) or Widevine challenge + license (aac-lc), lyrics and cover in
   parallel with the media download.
5. **Download** (`core/download.ts`): probe size via first `Range: bytes=0-` response `Content-Range`, then 4 parallel
   8 MiB ranges into one preallocated `ArrayBuffer`, per-range retries (3), `AbortSignal` cancel, throttled progress.
6. **Decrypt in place** on the encrypted buffer (both schemes keep sample sizes):
   - Parse init + fragments (`core/mp4/fragments.ts`): per fragment the absolute sample `(offset, size)` list from
     `tfhd`/`trun`/`trex`, `sample_description_index` (tfhd override or trex default), and for CENC the `senc`
     IVs/subsamples plus `tenc` defaults.
   - **FairPlay**: key URI = `keys[sampleDescriptionIndex - 1]` (fallback `keys[0]` with a warning) exactly as
     `streamDecryptToWriter`. Fragments are batched to ≥ 256 KiB jobs and sent to `FairPlayPool` (§5).
   - **Widevine CENC**: AES-128-CTR via WebCrypto (`counter = IV‖0…`, `length: 64`), subsample-aware, on the
     offscreen main thread (≈150 MB/s natively; no worker needed).
7. **Flatten + tag** (`core/mp4/flatten.ts`, `core/mp4/tags.ts`): 1:1 TS port of `experiments/browser/m4a/`
   (`box.go`, `flatten.go`, `tags.go`) operating on the in-place-decrypted fMP4. The decrypted-init rewrite that
   mp4ff did in Go (`prepareDecryptedInit`) happens while building the output `moov`: `enca`→original format from
   `sinf/frma`, drop `sinf`/`pssh`, drop `seig`/`seam` `sgpd`/`sbgp`, collapse multiple `stsd` entries to one;
   `senc`/`saiz`/`saio` are simply ignored. Output is a `Blob` assembled from parts
   (`ftyp`, `mdat` header, sample-data `subarray`s, `moov` with `ilst`) — no second full-track copy in JS heap.
   Tags = `engine/song.go` `buildTags` (go-mp4tag atom layout as in `tags.go`), cover `covr`, lyrics `©lyr` (LRC from
   TTML via a port of `engine/lyrics.go`).
8. **Save**: offscreen `URL.createObjectURL(blob)` → SW `chrome.downloads.download({url, filename, conflictAction:
   "uniquify", saveAs})` → revoke on `onChanged` complete/interrupted. Default filename template
   `Apple Music/{albumArtist}/{album}/{songNumber:02}. {title}.m4a` (sanitised as `safeName`).

Queue: tracks run with configurable concurrency (default 2), album enqueue expands to tracks; per-job cancel/retry.
Job state is broadcast as `{jobId, songId, title, stage, done, total, error?, notes[]}`.

## 5. FairPlay: `temari-wasm` + worker pool

- `crates/temari-wasm/`: thin `cdylib` over **vendored** Temari v0.5.1 core (`rounds.rs`, `rounds_gen.rs`,
  `template.rs` copied from `~/go/pkg/mod/github.com/!world!observation!log/!temari/bindings/go@v0.5.1/crate/src`,
  MIT notice kept in `third_party/temari/LICENSE` + file headers). `pool.rs`, `stream.rs`, `ffi.rs` are **not** used.
  Profile: `opt-level=3, lto=true, codegen-units=1, panic="abort", strip=true`, target `wasm32-unknown-unknown`.
- Exports (no wasm-bindgen, no JS bump allocator — upstream `bindings/wasm/temari.js` is forbidden):
  `wasm_alloc(len) -> ptr`, `wasm_dealloc(ptr, len)`, `template_new(json_ptr, json_len) -> handle (0 = error)`,
  `template_free(handle)`, `decrypt_samples(handle, buf_ptr, table_ptr, count) -> status` which decrypts each
  `(offset:u32, size:u32)` sample of `buf` in place (16-byte-aligned prefix, tail untouched) through a reused scratch
  buffer (`decrypt_region_into`, single lane).
- Build: `scripts/build-wasm.sh` in Docker `rust:1.85-slim` (cached locally); the built `temari.wasm` (~109 KiB) is
  committed so a JS-only build needs no Rust toolchain. Golden test: Temari vector `track_1720704575_s1`
  (copy `internal/fairplay/testdata/track_1720704575_s1.{json,ct,pt}` with its README/MIT note).
- `FairPlayPool`: `min(hardwareConcurrency, 8)` workers created lazily, idle-terminated after 60 s. Each worker
  keeps `Map<keyUri, handle>`; template JSON is posted once per worker. Job = `{keyUri, buffer (Transferable copy
  of the fragment batch's byte range), table}`; result transfers back and is copied into the track buffer. Worker
  growth is bounded by reusing one wasm input buffer per worker (grow-only), freed on idle.
- CSP: `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`.

## 6. Widevine L3 (`src/core/widevine/`)

TS port of the parts of `github.com/iyear/gowidevine@v0.1.3` that amdl uses (GPL-3.0 → compatible with AGPL-3.0;
keep attribution in file headers), using WebCrypto only:
- `wvd.ts`: parse WVD v2 (`"WVD"`, version 2, type, security level, flags, u16-len PKCS#1 private key, u16-len
  ClientIdentification blob); wrap PKCS#1 into PKCS#8 for `importKey`.
- `proto.ts`: minimal protobuf varint/length-delimited writer/reader for `WidevinePsshData`, `LicenseRequest`
  (client_id, content_id.widevine_pssh_data{pssh_data, license_type AUTOMATIC, request_id}, type NEW,
  request_time, protocol_version 2.1, key_control_nonce), `SignedMessage`, `License.KeyContainer`.
  Field numbers from `widevinepb/license.proto`.
- `cdm.ts`: challenge = `SignedMessage{type LICENSE_REQUEST, msg, signature RSA-PSS(SHA-1, salt 20)}`; license →
  `session_key` RSA-OAEP(SHA-1) → `enc_key = AES-CMAC(session_key, 0x01‖"ENCRYPTION"‖0x00‖msg‖0x00000080)` →
  each CONTENT key AES-128-CBC(enc_key, iv) unpadded. `cmac.ts` implements RFC 4493 on top of WebCrypto AES-CBC
  (zero IV, first block) and is tested with the RFC vectors. MAC verification (`AUTHENTICATION` keys, HMAC-SHA256)
  is implemented and enforced.
- Device: embedded test L3 `.wvd` (`engine/aaclc.go` `widevineDeviceBase64`) in `device.ts`; options may later accept
  a user-supplied `.wvd`.

## 7. UI

- **Injection** (`content/inject.ts`): SPA-aware (`navigation` API `navigatesuccess` + URL polling fallback +
  `MutationObserver` scoped to `main`). Routes: `/{sf}/album/{slug?}/{id}`, `/{sf}/song/{slug?}/{id}`,
  `/{sf}/album/...?...i={songId}`, playlist pages later.
  - Header: "Download" button appended to `.primary-actions` (album → all tracks; song → that track).
  - Track rows: small download icon inserted into `[data-testid="track-column-controls"]`; row → song id by
    `data-row` index against the album's track list fetched once through the offscreen (`resolveAlbum`), falling back
    to `a[href*="i="]` links. Per-row progress ring + done/error state from job broadcasts.
  - Shadow-DOM-isolated styles, follows page dark/light (`prefers-color-scheme`), no layout shift.
- **Popup**: mode badge (Zero-config AAC-LC / Wrapper: regions), current queue with progress, cancel/retry, clear.
- **Options**: wrapper URL + token (+ "Test connection" → `/status` regions), codec select (disabled without wrapper),
  ALAC max sample rate (44100/48000/96000/192000) & bit depth (16/24), fallback toggle, lyrics (embed, line/word,
  translation/pronunciation extras), cover (embed, size, jpg/png), filename template, concurrency, save-as prompt.
  Settings in `chrome.storage.local` (single `settings` object with schema version).

## 8. Build, tests, verification

- Tooling: pnpm, TypeScript (strict), esbuild bundling (`scripts/build.mjs` → `dist/`, one bundle per entry; worker
  bundled separately), vitest. No runtime npm dependencies. `@types/chrome` dev-only.
- Unit tests: HLS parsing/selection, URL/route parsing, fragment parser, CENC decrypt (synthetic), CMAC RFC vectors,
  protobuf round trips, TTML→LRC (fixtures from the Go tests), flatten/tags against fixtures, wasm golden vector.
- **Node reference CLI** `scripts/cli.ts` runs `src/core/pipeline.ts` in Node (wrapper mode needs no Apple login;
  web JWT scraped; Node can set `Origin`). It is the main E2E harness: run the HANDOFF §5 matrix against
  `http://wrapper.lan`, including `aac-lc` via wrapper `/webplayback` + `/license` (exercises the TS Widevine CDM
  without a user token). Compare with the Go reference
  (`go run ./experiments/browser/engine/internal/nativerun ...` on `exp/browser-pipeline`, outputs under `/tmp`):
  decoded PCM MD5 must match; byte-identical SHA-256 is the target and any difference must be explained.
  Every output passes `ffmpeg -v error -i <f> -f null -` and `ffprobe` (stream, duration, tags, `covr`, `©lyr`).
- Extension smoke test: load `dist/` unpacked in a throwaway Chromium profile (never lyjw's daily profile), verify
  injection, wrapper-mode downloads and the M0 transport checks. Zero-config `aac-lc` with a real logged-in session
  is verified with lyjw separately.

## 9. Milestones

- **M0 spike**: manifest + SW + offscreen skeleton; verify DNR `Origin` rewrite on offscreen fetches to amp-api,
  `http://wrapper.lan` reachability from offscreen, offscreen `Worker` + wasm instantiate under the CSP. Record results
  in this file (§0) and pick transports.
- **M1 core**: `core/` modules + unit tests + `temari-wasm` + Node CLI; FairPlay matrix vs Go reference.
- **M2 Widevine**: TS CDM + CENC; aac-lc via wrapper in CLI vs Go reference.
- **M3 extension**: offscreen pipeline, worker pool, downloads, injection, popup/options.
- **M4 polish**: album queue, errors/notes UX, README usage docs.
