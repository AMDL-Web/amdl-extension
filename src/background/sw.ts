import type {
  OffscreenForwardEnvelope,
  PageTokens,
  RuntimeRequest,
} from "../shared/messages.ts";
import { loadSettings } from "../shared/settings.ts";

const APPLE_DNR_RULE_ID = 1001;
const APPLE_API_DOMAINS = [
  "amp-api.music.apple.com",
  "play.music.apple.com",
  "play.itunes.apple.com",
];

let dnrInstalled = false;
let offscreenCreating: Promise<void> | null = null;
const downloadBlobUrls = new Map<number, string>();

async function ensureAppleDnrRule(): Promise<void> {
  if (dnrInstalled) return;
  const extensionId = chrome.runtime.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [APPLE_DNR_RULE_ID],
    addRules: [
      {
        id: APPLE_DNR_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: "Origin",
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: "https://music.apple.com",
            },
            {
              header: "Referer",
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: "https://music.apple.com/",
            },
          ],
        },
        condition: {
          requestDomains: APPLE_API_DOMAINS,
          initiatorDomains: [extensionId],
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          ],
        },
      },
    ],
  });
  dnrInstalled = true;
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen/offscreen.html",
        reasons: [
          chrome.offscreen.Reason.WORKERS,
          chrome.offscreen.Reason.BLOBS,
        ],
        justification:
          "Run FairPlay WebAssembly worker pool, Widevine CDM, and audio Blob assembly.",
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function readMediaUserTokenCookie(): Promise<string | undefined> {
  try {
    const cookie = await chrome.cookies.get({
      url: "https://music.apple.com",
      name: "media-user-token",
    });
    const val = cookie?.value?.trim();
    return val || undefined;
  } catch {
    return undefined;
  }
}

async function enrichTokensWithCookie(
  tokens?: PageTokens,
): Promise<PageTokens | undefined> {
  if (tokens?.musicUserToken?.trim()) return tokens;
  const cookieToken = await readMediaUserTokenCookie();
  if (!cookieToken) return tokens;
  return { ...(tokens ?? {}), musicUserToken: cookieToken };
}

async function refreshTokensFromOpenTabs(): Promise<PageTokens> {
  const merged: PageTokens = {};
  try {
    const tabs = await chrome.tabs.query({ url: "https://music.apple.com/*" });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const res = (await chrome.tabs.sendMessage(tab.id, {
          type: "content-get-tokens",
        })) as PageTokens | undefined;
        if (res?.developerToken) merged.developerToken = res.developerToken;
        if (res?.musicUserToken) merged.musicUserToken = res.musicUserToken;
        if (res?.storefrontId) merged.storefrontId = res.storefrontId;
        if (res?.language) merged.language = res.language;
        if (merged.developerToken && merged.musicUserToken) break;
      } catch {
        // Tab may not have content script ready yet.
      }
    }
  } catch {
    // ignore
  }
  if (!merged.musicUserToken) {
    const cookieTok = await readMediaUserTokenCookie();
    if (cookieTok) merged.musicUserToken = cookieTok;
  }
  return merged;
}

async function forwardToOffscreen(
  payload: RuntimeRequest,
  extraTokens?: PageTokens,
): Promise<unknown> {
  await ensureAppleDnrRule();
  await ensureOffscreen();
  const settings = await loadSettings();
  const envelope: OffscreenForwardEnvelope = {
    target: "offscreen",
    payload,
    settings,
    ...(extraTokens ? { tokens: extraTokens } : {}),
  };
  return chrome.runtime.sendMessage(envelope);
}

async function relayJobUpdateToTabs(
  msg: Extract<RuntimeRequest, { type: "offscreen-job-update" }>,
): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://music.apple.com/*" });
    await Promise.allSettled(
      tabs
        .filter((t) => t.id !== undefined)
        .map((t) =>
          chrome.tabs.sendMessage(t.id!, {
            type: "job-update",
            job: msg.job,
          }),
        ),
    );
  } catch {
    // ignore
  }
}

async function revokeBlobInOffscreen(blobUrl: string): Promise<void> {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) return;
    await chrome.runtime.sendMessage({
      target: "offscreen",
      payload: { type: "offscreen-revoke-blob", blobUrl },
    } satisfies OffscreenForwardEnvelope);
  } catch {
    // ignore
  }
}

async function injectContentScriptsIntoOpenTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://music.apple.com/*" });
    await Promise.allSettled(
      tabs
        .filter((t) => t.id !== undefined)
        .map(async (tab) => {
          const tabId = tab.id!;
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/main-world.js"],
            world: "MAIN",
          });
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/inject.js"],
            world: "ISOLATED",
          });
        }),
    );
  } catch {
    // Ignore tabs that cannot be scripted (discarded, navigating, etc.).
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  dnrInstalled = false;
  void ensureAppleDnrRule();
  if (details.reason === "install" || details.reason === "update") {
    void injectContentScriptsIntoOpenTabs();
  }
});

chrome.runtime.onStartup.addListener(() => {
  dnrInstalled = false;
  void ensureAppleDnrRule();
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const blobUrl = downloadBlobUrls.get(delta.id);
  if (blobUrl) {
    downloadBlobUrls.delete(delta.id);
    void revokeBlobInOffscreen(blobUrl);
  }
});

chrome.runtime.onMessage.addListener((rawMsg: unknown, _sender, sendResponse) => {
  if (!rawMsg || typeof rawMsg !== "object") return false;
  // Never intercept envelopes meant for the offscreen document.
  if ((rawMsg as { target?: string }).target === "offscreen") return false;

  const msg = rawMsg as RuntimeRequest;
  switch (msg.type) {
    case "enqueue-song":
    case "enqueue-album":
    case "enqueue-library-album":
    case "enqueue-playlist":
    case "enqueue-library-playlist":
    case "resolve-album":
    case "resolve-collection":
    case "resolve-library-lockup": {
      void (async () => {
        const tokens = await enrichTokensWithCookie(msg.tokens);
        return forwardToOffscreen({ ...msg, tokens }, tokens);
      })()
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    case "get-jobs":
    case "cancel-job":
    case "retry-job":
    case "clear-finished":
    case "test-wrapper":
    case "settings-updated": {
      void forwardToOffscreen(msg)
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    case "offscreen-job-update": {
      void relayJobUpdateToTabs(msg);
      return false;
    }

    case "offscreen-save-blob": {
      void (async () => {
        try {
          const downloadId = await chrome.downloads.download({
            url: msg.blobUrl,
            filename: msg.filename,
            conflictAction: "uniquify",
            saveAs: msg.saveAs,
          });
          downloadBlobUrls.set(downloadId, msg.blobUrl);
          sendResponse({ ok: true, downloadId });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    case "offscreen-refresh-tokens": {
      void refreshTokensFromOpenTabs()
        .then(sendResponse)
        .catch(() => sendResponse({}));
      return true;
    }

    default:
      return false;
  }
});
