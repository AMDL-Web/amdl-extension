#!/usr/bin/env node
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { AppleApi } from "../src/core/apple-api.ts";
import {
  SingleThreadFairPlayDecryptor,
  TemariWasmInstance,
} from "../src/core/fairplay.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import {
  type Codec,
  type CoverFormat,
  type LyricsExtra,
  type LyricsTiming,
  createConsoleLogger,
} from "../src/core/types.ts";
import { WrapperClient } from "../src/core/wrapper-client.ts";

const { values } = parseArgs({
  options: {
    id: { type: "string", default: "1538278601" },
    storefront: { type: "string", default: "cn" },
    language: { type: "string", default: "zh-Hans_CN" },
    codec: { type: "string", default: "alac" },
    wrapper: { type: "string", default: "http://wrapper.lan" },
    "wrapper-token": { type: "string", default: "" },
    "media-user-token": { type: "string", default: "" },
    out: { type: "string", default: "/tmp/amdl-ts-cli" },
    lyrics: { type: "boolean", default: true },
    cover: { type: "boolean", default: true },
    "cover-size": { type: "string", default: "5000x5000" },
    "cover-format": { type: "string", default: "jpg" },
    "lyrics-timing": { type: "string", default: "line" },
    "max-sample-rate": { type: "string", default: "192000" },
    "max-bit-depth": { type: "string", default: "24" },
    fallback: { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
  },
  allowNegative: true,
});

const outDir = path.resolve(values.out);
if (!`${outDir}/`.startsWith("/tmp/")) {
  console.error("--out must be under /tmp");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const wasmBytes = readFileSync(path.resolve("src/wasm/temari.wasm"));
const wasmInstance = await TemariWasmInstance.fromBytes(wasmBytes);
const fairPlayDecryptor = new SingleThreadFairPlayDecryptor(wasmInstance);

const logger = createConsoleLogger("[amdl-cli]", values.verbose);
const appleApi = new AppleApi({
  language: values.language,
  sendOriginHeader: true,
  logger,
});
const wrapper = values.wrapper
  ? new WrapperClient({
      address: values.wrapper,
      token: values["wrapper-token"] || undefined,
    })
  : undefined;

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

let lastStage = "";
try {
  const result = await runPipeline({
    url: values.id,
    storefront: values.storefront,
    language: values.language,
    codec: values.codec as Codec,
    maxSampleRate: Number.parseInt(values["max-sample-rate"], 10) || 0,
    maxBitDepth: Number.parseInt(values["max-bit-depth"], 10) || 0,
    fallbackOnCodecNotFound: values.fallback,
    mediaUserToken: values["media-user-token"] || undefined,
    embedLyrics: values.lyrics,
    lyricsTiming: values["lyrics-timing"] as LyricsTiming,
    lyricsExtras: [] as LyricsExtra[],
    embedCover: values.cover,
    coverSize: values["cover-size"],
    coverFormat: values["cover-format"] as CoverFormat,
    appleApi,
    wrapper,
    fairPlayDecryptor,
    logger,
    signal: controller.signal,
    onProgress(ev) {
      if (!values.verbose && ev.stage === lastStage) return;
      lastStage = ev.stage;
      if (ev.total > 0) {
        console.error(`[${ev.stage}] ${ev.message} ${ev.done}/${ev.total}`);
      } else {
        console.error(`[${ev.stage}] ${ev.message}`);
      }
    },
  });

  const outPath = path.join(outDir, result.fileName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(outPath);
    ws.on("error", reject);
    ws.on("finish", resolve);
    for (const part of result.parts) {
      ws.write(part);
    }
    ws.end();
  });

  console.log(
    JSON.stringify(
      {
        fileName: result.fileName,
        outPath,
        song: result.song,
        stream: result.stream,
        sizes: result.sizes,
        timingsMs: result.timingsMs,
        decryptMBps: Number(result.decryptMBps.toFixed(2)),
        notes: result.notes,
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timeout);
  fairPlayDecryptor.dispose();
}
