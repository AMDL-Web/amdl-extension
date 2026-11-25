import { PREFETCH_KEY } from "./hls.ts";

export interface WrapperInstance {
  id: string;
  region: string;
  name: string;
  ready: boolean;
  degraded?: boolean;
}

export interface WrapperStatus {
  ready: boolean;
  loggedIn: boolean;
  regions: string[];
  loginSupported: boolean;
  instances: WrapperInstance[];
}

export interface WrapperLyricsOptions {
  language?: string;
  syllable: boolean;
  script?: string;
}

export class WrapperError extends Error {
  readonly endpoint: string;
  readonly httpStatus: number;
  readonly code: number;
  readonly serverMsg: string;

  constructor(
    endpoint: string,
    httpStatus: number,
    code: number,
    serverMsg: string,
  ) {
    super(
      code === 0
        ? `wrapper ${endpoint}: HTTP ${httpStatus}: ${serverMsg}`
        : `wrapper ${endpoint}: code ${code}: ${serverMsg}`,
    );
    this.name = "WrapperError";
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.code = code;
    this.serverMsg = serverMsg;
  }

  get clientFault(): boolean {
    const st = this.code !== 0 ? this.code : this.httpStatus;
    return st >= 400 && st < 500;
  }
}

export function normalizeWrapperAddress(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (s && !s.includes("://")) {
    s = `http://${s}`;
  }
  return s;
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve(() => this.release());
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(wake);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      this.queue.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const KEY_RETRY_DELAYS_MS = [1000, 2000, 4000];
const TEMPLATE_CACHE_LIMIT = 64;

export interface WrapperClientOptions {
  address: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class WrapperClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  private readonly playbackLimit = new Semaphore(2);
  private readonly manifestLimit = new Semaphore(1);
  private readonly dataLimit = new Semaphore(4);

  // LRU cache of raw FairPlay template JSON strings keyed by key URI.
  // Insertion order in Map acts as LRU (oldest first); PREFETCH_KEY is pinned separately.
  private pinnedPrefetchJson: string | null = null;
  private readonly templateLru = new Map<string, string>();
  private readonly inFlightTemplates = new Map<string, Promise<string>>();

  constructor(opts: WrapperClientOptions) {
    const normalized = normalizeWrapperAddress(opts.address);
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new Error(`invalid wrapper address "${opts.address}"`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.host
    ) {
      throw new Error(
        `wrapper address "${opts.address}" is not an http:// or https:// URL`,
      );
    }
    this.baseUrl = normalized;
    this.token = (opts.token ?? "").trim();
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async call(
    method: "GET" | "POST",
    endpoint: string,
    query?: Record<string, string>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(endpoint, `${this.baseUrl}/`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {};
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    let bodyText: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new DOMException("Aborted", "AbortError");
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new Error(
          `wrapper ${endpoint}: timed out after ${this.timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const rawText = await resp.text();
    let env: { code?: number; msg?: string; data?: unknown };
    try {
      env = JSON.parse(rawText) as { code?: number; msg?: string; data?: unknown };
    } catch {
      throw new WrapperError(
        endpoint,
        resp.status,
        0,
        rawText.slice(0, 200),
      );
    }
    const code = typeof env.code === "number" ? env.code : 0;
    if (code !== 0 || resp.status !== 200) {
      throw new WrapperError(
        endpoint,
        resp.status,
        code,
        String(env.msg ?? ""),
      );
    }
    return env.data;
  }

  async status(signal?: AbortSignal): Promise<WrapperStatus> {
    const data = (await this.call("GET", "/status", undefined, undefined, signal)) as {
      regions?: string[];
      clientCount?: number;
      ready?: boolean;
      instances?: WrapperInstance[];
    } | null;
    const regions = Array.isArray(data?.regions) ? data.regions : [];
    const instances = Array.isArray(data?.instances)
      ? data.instances.filter((i) => Boolean(i?.id))
      : [];
    return {
      ready: data?.ready ?? true,
      loggedIn: regions.length > 0,
      regions,
      loginSupported: data?.clientCount !== undefined,
      instances,
    };
  }

  async m3u8(adamId: string, signal?: AbortSignal): Promise<string> {
    const relManifest = await this.manifestLimit.acquire(signal);
    try {
      const relPlayback = await this.playbackLimit.acquire(signal);
      try {
        const data = (await this.call(
          "GET",
          "/m3u8",
          { adamId },
          undefined,
          signal,
        )) as { m3u8?: string } | null;
        return data?.m3u8 ?? "";
      } finally {
        relPlayback();
      }
    } finally {
      relManifest();
    }
  }

  async lyrics(
    adamId: string,
    opts: WrapperLyricsOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const query: Record<string, string> = {
      adamId,
      syllable: opts.syllable ? "1" : "0",
    };
    if (opts.language) query.language = opts.language;
    if (opts.script) query.script = opts.script;
    const rel = await this.dataLimit.acquire(signal);
    try {
      const data = (await this.call(
        "GET",
        "/lyrics",
        query,
        undefined,
        signal,
      )) as { lyrics?: string } | null;
      return data?.lyrics ?? "";
    } finally {
      rel();
    }
  }

  async webPlayback(adamId: string, signal?: AbortSignal): Promise<string> {
    const rel = await this.dataLimit.acquire(signal);
    try {
      const data = (await this.call(
        "GET",
        "/webplayback",
        { adamId },
        undefined,
        signal,
      )) as { m3u8?: string } | null;
      return data?.m3u8 ?? "";
    } finally {
      rel();
    }
  }

  async license(
    adamId: string,
    challengeBase64: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const rel = await this.dataLimit.acquire(signal);
    try {
      const data = (await this.call(
        "POST",
        "/license",
        undefined,
        { adamId, challenge: challengeBase64, uri },
        signal,
      )) as { license?: string } | null;
      if (!data?.license) {
        throw new Error("wrapper /license reply has no license");
      }
      return data.license;
    } finally {
      rel();
    }
  }

  /**
   * Fetch (or return cached) FairPlay key template JSON string for `keyUri`.
   * Pinned prefetch key is always requested with `adamId = "0"`.
   * Retries up to 3 times (1s / 2s / 4s) on 5xx or network errors.
   */
  async getKeyTemplate(
    adamId: string,
    keyUri: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const pinned = keyUri === PREFETCH_KEY;
    if (pinned && this.pinnedPrefetchJson !== null) {
      return this.pinnedPrefetchJson;
    }
    if (!pinned) {
      const hit = this.templateLru.get(keyUri);
      if (hit !== undefined) {
        // Touch LRU
        this.templateLru.delete(keyUri);
        this.templateLru.set(keyUri, hit);
        return hit;
      }
    }

    const existing = this.inFlightTemplates.get(keyUri);
    if (existing) {
      return existing;
    }

    const reqAdamId = pinned ? "0" : adamId;
    const p = this.fetchKeyTemplateWithRetry(reqAdamId, keyUri, signal).then(
      (json) => {
        if (pinned) {
          this.pinnedPrefetchJson = json;
        } else {
          this.templateLru.set(keyUri, json);
          while (this.templateLru.size > TEMPLATE_CACHE_LIMIT) {
            const oldest = this.templateLru.keys().next().value;
            if (oldest !== undefined) this.templateLru.delete(oldest);
            else break;
          }
        }
        return json;
      },
    );

    this.inFlightTemplates.set(keyUri, p);
    try {
      return await p;
    } finally {
      if (this.inFlightTemplates.get(keyUri) === p) {
        this.inFlightTemplates.delete(keyUri);
      }
    }
  }

  async prepareKeys(
    adamId: string,
    keys: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const unique = Array.from(new Set(keys.filter(Boolean)));
    const result = new Map<string, string>();
    const settled = await Promise.allSettled(
      unique.map(async (k) => {
        const json = await this.getKeyTemplate(adamId, k, signal);
        result.set(k, json);
      }),
    );
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    if (errors.length > 0 && result.size === 0) {
      throw new Error(errors.join("; "));
    }
    return result;
  }

  private async fetchKeyTemplateWithRetry(
    adamId: string,
    keyUri: string,
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const rel = await this.playbackLimit.acquire(signal);
        let data: unknown;
        try {
          data = await this.call(
            "GET",
            "/key",
            { adamId, uri: keyUri },
            undefined,
            signal,
          );
        } finally {
          rel();
        }
        if (
          !data ||
          typeof data !== "object" ||
          typeof (data as Record<string, unknown>).ctx !== "string" ||
          typeof (data as Record<string, unknown>).state !== "string"
        ) {
          throw new Error("wrapper /key returned incomplete template data");
        }
        return JSON.stringify(data);
      } catch (err) {
        const retryable =
          !signal?.aborted &&
          !(err instanceof WrapperError && err.clientFault);
        if (!retryable || attempt >= KEY_RETRY_DELAYS_MS.length) {
          throw new Error(
            `fetch key template for ${keyUri} (attempt ${attempt + 1}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        await sleepAbortable(KEY_RETRY_DELAYS_MS[attempt]!, signal);
      }
    }
  }
}
