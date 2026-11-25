const MAX_PLAYLIST_BYTES = 4 << 20;
const MAX_MEDIA_BYTES = 1 << 30;
const RANGE_CHUNK_SIZE = 8 << 20; // 8 MiB per range
const DEFAULT_CONCURRENCY = 4;
const MAX_RANGE_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith("bytes ")) return null;
  const rest = trimmed.slice(6);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const span = rest.slice(0, slash);
  const totalStr = rest.slice(slash + 1);
  const dash = span.indexOf("-");
  if (dash < 0) return null;
  const start = Number.parseInt(span.slice(0, dash), 10);
  const end = Number.parseInt(span.slice(dash + 1), 10);
  const total = totalStr === "*" ? 0 : Number.parseInt(totalStr, 10);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(total) ||
    start < 0 ||
    end < start
  ) {
    return null;
  }
  return { start, end, total };
}

async function fetchTimed(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function downloadText(
  uri: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resp = await fetchTimed(fetchImpl, uri, { method: "GET" }, opts.signal);
  if (!resp.ok) {
    throw new Error(`download ${uri} failed: ${resp.status} ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_PLAYLIST_BYTES) {
    throw new Error(`playlist ${uri} exceeds ${MAX_PLAYLIST_BYTES} bytes`);
  }
  return new TextDecoder().decode(buf);
}

async function readStreamInto(
  resp: Response,
  target: Uint8Array,
  targetOffset: number,
  expectedLen: number,
  onDelta: (delta: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.length > expectedLen) {
      throw new Error(`range response exceeded expected length ${expectedLen}`);
    }
    target.set(bytes, targetOffset);
    onDelta(bytes.length);
    return bytes.length;
  }
  const reader = resp.body.getReader();
  let written = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (written + value.byteLength > expectedLen) {
          throw new Error(
            `range response exceeded expected length ${expectedLen}`,
          );
        }
        target.set(value, targetOffset + written);
        written += value.byteLength;
        onDelta(value.byteLength);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return written;
}

async function readFullStream(
  resp: Response,
  totalHint: number,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!resp.body) {
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) {
      throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
    }
    onProgress(bytes.length, totalHint || bytes.length);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let doneBytes = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        doneBytes += value.byteLength;
        if (doneBytes > MAX_MEDIA_BYTES) {
          throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
        }
        chunks.push(value);
        onProgress(doneBytes, totalHint);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(doneBytes);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export interface DownloadMediaOptions {
  signal?: AbortSignal;
  concurrency?: number;
  chunkSize?: number;
  fetchImpl?: typeof globalThis.fetch;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Downloads encrypted media into a single preallocated ArrayBuffer-backed
 * Uint8Array. Probes size via an initial `Range: bytes=0-(chunkSize-1)` GET
 * (so tracks <= 8 MiB finish in 1 RTT), then fetches remaining 8 MiB ranges
 * in parallel (concurrency 4, 3 retries per range). Falls back to streaming
 * if the server replies 200 OK instead of 206.
 */
export async function downloadMedia(
  uri: string,
  opts: DownloadMediaOptions = {},
): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const chunkSize = opts.chunkSize ?? RANGE_CHUNK_SIZE;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const signal = opts.signal;

  let lastProgressAt = 0;
  let totalDone = 0;
  let totalBytes = 0;
  const emitProgress = (force = false) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 100 && (totalBytes <= 0 || totalDone < totalBytes)) {
      return;
    }
    lastProgressAt = now;
    opts.onProgress(totalDone, totalBytes);
  };

  // Initial range probe + first chunk download.
  const firstEnd = chunkSize - 1;
  let firstResp: Response | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RANGE_RETRIES; attempt++) {
    try {
      const resp = await fetchTimed(
        fetchImpl,
        uri,
        { method: "GET", headers: { Range: `bytes=0-${firstEnd}` } },
        signal,
        60_000,
      );
      if (resp.status === 206 || resp.status === 200) {
        firstResp = resp;
        break;
      }
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        throw new Error(`download media failed: ${resp.status} ${resp.statusText}`);
      }
      lastErr = new Error(`download media failed: ${resp.status} ${resp.statusText}`);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, (attempt + 1) * 500));
  }
  if (!firstResp) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("download media failed");
  }

  // Server returned full body without Range support.
  if (firstResp.status === 200) {
    const cl = Number.parseInt(firstResp.headers.get("content-length") ?? "0", 10);
    totalBytes = Number.isFinite(cl) && cl > 0 ? cl : 0;
    if (totalBytes > MAX_MEDIA_BYTES) {
      throw new Error(`media of ${totalBytes} bytes exceeds ${MAX_MEDIA_BYTES}`);
    }
    const full = await readFullStream(
      firstResp,
      totalBytes,
      (done, total) => {
        totalDone = done;
        totalBytes = total;
        emitProgress(false);
      },
      signal,
    );
    totalDone = full.byteLength;
    totalBytes = full.byteLength;
    emitProgress(true);
    return full;
  }

  const cr = parseContentRange(firstResp.headers.get("content-range"));
  if (!cr || cr.start !== 0 || cr.total <= 0) {
    // Unexpected 206 without usable total — fall back to a plain GET.
    await firstResp.arrayBuffer().catch(() => {});
    const plain = await fetchTimed(fetchImpl, uri, { method: "GET" }, signal, 120_000);
    if (!plain.ok) {
      throw new Error(`download media failed: ${plain.status}`);
    }
    const full = await readFullStream(
      plain,
      0,
      (done, total) => {
        totalDone = done;
        totalBytes = total;
        emitProgress(false);
      },
      signal,
    );
    totalDone = full.byteLength;
    totalBytes = full.byteLength;
    emitProgress(true);
    return full;
  }

  totalBytes = cr.total;
  if (totalBytes > MAX_MEDIA_BYTES) {
    throw new Error(`media of ${totalBytes} bytes exceeds ${MAX_MEDIA_BYTES}`);
  }

  const out = new Uint8Array(new ArrayBuffer(totalBytes));
  const firstExpected = cr.end - cr.start + 1;
  const firstWritten = await readStreamInto(
    firstResp,
    out,
    0,
    firstExpected,
    (delta) => {
      totalDone += delta;
      emitProgress(false);
    },
    signal,
  );
  if (firstWritten !== firstExpected) {
    throw new Error(
      `first range truncated: got ${firstWritten} of ${firstExpected} bytes`,
    );
  }

  if (firstWritten >= totalBytes) {
    emitProgress(true);
    return out;
  }

  // Queue remaining ranges.
  const ranges: { start: number; end: number }[] = [];
  for (let start = firstWritten; start < totalBytes; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, totalBytes - 1);
    ranges.push({ start, end });
  }

  let nextIdx = 0;
  const downloadRange = async (start: number, end: number): Promise<void> => {
    const expected = end - start + 1;
    let rangeErr: unknown;
    for (let attempt = 0; attempt < MAX_RANGE_RETRIES; attempt++) {
      let writtenThisAttempt = 0;
      try {
        const resp = await fetchTimed(
          fetchImpl,
          uri,
          { method: "GET", headers: { Range: `bytes=${start}-${end}` } },
          signal,
          60_000,
        );
        if (resp.status !== 206) {
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            throw new Error(`range ${start}-${end} failed: HTTP ${resp.status}`);
          }
          throw new Error(`range ${start}-${end} returned HTTP ${resp.status}`);
        }
        const got = await readStreamInto(
          resp,
          out,
          start,
          expected,
          (delta) => {
            writtenThisAttempt += delta;
            totalDone += delta;
            emitProgress(false);
          },
          signal,
        );
        if (got === expected) return;
        throw new Error(`range ${start}-${end} truncated: ${got}/${expected}`);
      } catch (err) {
        // Roll back progress counted during failed attempt so progress stays accurate.
        totalDone -= writtenThisAttempt;
        if (signal?.aborted) throw err;
        rangeErr = err;
        if (attempt + 1 < MAX_RANGE_RETRIES) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 500));
        }
      }
    }
    throw rangeErr instanceof Error
      ? rangeErr
      : new Error(`range ${start}-${end} failed`);
  };

  const worker = async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= ranges.length) return;
      const r = ranges[i]!;
      await downloadRange(r.start, r.end);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, ranges.length) },
    () => worker(),
  );
  await Promise.all(workers);
  emitProgress(true);
  return out;
}
