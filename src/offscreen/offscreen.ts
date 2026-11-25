// M0 spike Offscreen Document skeleton.

const INDEX_JS_RE = /\/assets\/index~[^"']+\.js/;
const JWT_RE = /eyJ[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+/;

let cachedJwt: string | null = null;

async function scrapeWebJwt(): Promise<string> {
  if (cachedJwt) return cachedJwt;
  const pageResp = await fetch("https://music.apple.com");
  if (!pageResp.ok) throw new Error(`music.apple.com status ${pageResp.status}`);
  const html = await pageResp.text();
  const jsMatch = html.match(INDEX_JS_RE);
  if (!jsMatch) throw new Error("index~*.js not found");
  const jsResp = await fetch(`https://music.apple.com${jsMatch[0]}`);
  if (!jsResp.ok) throw new Error(`index js status ${jsResp.status}`);
  const jsText = await jsResp.text();
  const jwtMatch = jsText.match(JWT_RE);
  if (!jwtMatch) throw new Error("JWT not found in index js");
  cachedJwt = jwtMatch[0];
  return cachedJwt;
}

async function checkAmpApi(storefront: string, songId: string) {
  const jwt = await scrapeWebJwt();
  const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/songs/${songId}?extend=extendedAssetUrls`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const text = await resp.text();
    let hasEnhancedHls = false;
    if (resp.ok) {
      try {
        const json = JSON.parse(text);
        hasEnhancedHls = Boolean(json?.data?.[0]?.attributes?.extendedAssetUrls?.enhancedHls);
      } catch {
        // ignore parse error
      }
    }
    return { ok: resp.ok, status: resp.status, hasEnhancedHls, bodySnippet: text.slice(0, 120) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function checkWrapper(wrapperUrl: string) {
  try {
    const resp = await fetch(`${wrapperUrl}/status`);
    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function checkWorkerWasm(goldenJson: string, goldenCtBase64: string, goldenPtBase64: string) {
  return new Promise((resolve) => {
    const workerUrl = chrome.runtime.getURL("offscreen/fairplay-worker.js");
    const wasmUrl = chrome.runtime.getURL("temari.wasm");
    const worker = new Worker(workerUrl);
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: "worker timeout" });
    }, 10_000);
    worker.onmessage = (ev) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(ev.data);
    };
    worker.onerror = (ev) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ ok: false, error: ev.message || "worker error" });
    };
    worker.postMessage({ wasmUrl, goldenJson, goldenCtBase64, goldenPtBase64 });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (msg.type === "m0-spike") {
    void (async () => {
      const amp = await checkAmpApi(msg.storefront, msg.songId);
      const wrapper = await checkWrapper(msg.wrapperUrl);
      const wasm = await checkWorkerWasm(msg.goldenJson, msg.goldenCtBase64, msg.goldenPtBase64);
      sendResponse({ amp, wrapper, wasm });
    })();
    return true;
  }
  if (msg.type === "m0-amp-check") {
    void checkAmpApi(msg.storefront, msg.songId).then(sendResponse);
    return true;
  }
  return false;
});
