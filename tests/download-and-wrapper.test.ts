import { describe, expect, it } from "vitest";
import { downloadMedia, parseContentRange } from "../src/core/download.ts";
import { PREFETCH_KEY } from "../src/core/hls.ts";
import {
  WrapperClient,
  WrapperError,
  normalizeWrapperAddress,
} from "../src/core/wrapper-client.ts";

describe("download & Content-Range", () => {
  it("parses Content-Range headers", () => {
    expect(parseContentRange("bytes 100-199/1000")).toEqual({
      start: 100,
      end: 199,
      total: 1000,
    });
    expect(parseContentRange("bytes 5-9/*")).toEqual({
      start: 5,
      end: 9,
      total: 0,
    });
    expect(parseContentRange("items 1-2/3")).toBeNull();
  });

  it("downloads multi-range payload in parallel into exact byte order", async () => {
    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    let calls = 0;

    const fakeFetch: typeof fetch = async (_url, init) => {
      calls++;
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      const m = range?.match(/^bytes=(\d+)-(\d+)$/);
      if (!m) return new Response(payload, { status: 200 });
      const start = Number.parseInt(m[1]!, 10);
      const end = Math.min(Number.parseInt(m[2]!, 10), payload.length - 1);
      return new Response(payload.subarray(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${payload.length}`,
        },
      });
    };

    const got = await downloadMedia("https://cdn.example/test.mp4", {
      fetchImpl: fakeFetch,
      chunkSize: 256,
      concurrency: 3,
    });
    expect(calls).toBe(4);
    expect(Buffer.from(got).equals(Buffer.from(payload))).toBe(true);
  });
});

describe("WrapperClient", () => {
  it("normalizes addresses", () => {
    expect(normalizeWrapperAddress("wrapper.lan/")).toBe("http://wrapper.lan");
    expect(normalizeWrapperAddress("https://w.example.com///")).toBe(
      "https://w.example.com",
    );
  });

  it("sends bearer token, pins prefetch key with adamId=0, caches templates, and retries 500s", async () => {
    const requests: { url: string; auth: string | null }[] = [];
    let keyAttempts = 0;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ??
        null;
      requests.push({ url, auth });
      const u = new URL(url);
      if (u.pathname === "/status") {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "SUCCESS",
            data: { ready: true, regions: ["cn", "jp"], clientCount: 2 },
          }),
          { status: 200 },
        );
      }
      if (u.pathname === "/key") {
        const uri = u.searchParams.get("uri");
        if (uri === PREFETCH_KEY) {
          expect(u.searchParams.get("adamId")).toBe("0");
          return new Response(
            JSON.stringify({
              code: 0,
              msg: "OK",
              data: { ctx: "AAAA", state: "BBBB" },
            }),
            { status: 200 },
          );
        }
        keyAttempts++;
        if (keyAttempts === 1) {
          return new Response(
            JSON.stringify({ code: 500, msg: "Invalid CKC error" }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "OK",
            data: { ctx: "CCCC", state: "DDDD" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ code: 404, msg: "not found" }), {
        status: 200,
      });
    };

    const client = new WrapperClient({
      address: "wrapper.lan",
      token: "secret-tok",
      fetchImpl: fakeFetch,
    });
    const st = await client.status();
    expect(st.regions).toEqual(["cn", "jp"]);
    expect(requests[0]!.auth).toBe("Bearer secret-tok");

    // Prefetch key uses adamId=0 and is cached
    const p1 = await client.getKeyTemplate("99999", PREFETCH_KEY);
    const p2 = await client.getKeyTemplate("88888", PREFETCH_KEY);
    expect(p1).toBe(p2);

    // Track key retries once after 500 and caches result
    const k1 = await client.getKeyTemplate("12345", "skd://x/c23");
    const k2 = await client.getKeyTemplate("12345", "skd://x/c23");
    expect(k1).toBe(k2);
    expect(keyAttempts).toBe(2);

    // 404 throws WrapperError with clientFault=true
    await expect(
      client.lyrics("12345", { syllable: true }),
    ).rejects.toMatchObject({
      code: 404,
      clientFault: true,
    });
    await expect(
      client.lyrics("12345", { syllable: true }),
    ).rejects.toBeInstanceOf(WrapperError);
  });
});
