// M0 spike Service Worker skeleton.

const APPLE_DNR_RULE_ID = 1001;
const APPLE_API_DOMAINS = [
  "amp-api.music.apple.com",
  "play.music.apple.com",
  "play.itunes.apple.com",
];

async function installAppleDnrRule(enable: boolean): Promise<void> {
  const extensionId = chrome.runtime.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [APPLE_DNR_RULE_ID],
    addRules: enable
      ? [
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
        ]
      : [],
  });
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: [
      chrome.offscreen.Reason.WORKERS,
      chrome.offscreen.Reason.BLOBS,
    ],
    justification: "Run FairPlay WebAssembly worker pool and assemble audio Blobs.",
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void installAppleDnrRule(true);
});

chrome.runtime.onStartup.addListener(() => {
  void installAppleDnrRule(true);
});

// Expose M0 spike harness on globalThis so automated checks can invoke it via CDP/Playwright.
(globalThis as unknown as Record<string, unknown>).__m0 = {
  installAppleDnrRule,
  ensureOffscreen,
  async runSpike(args: {
    songId: string;
    storefront: string;
    wrapperUrl: string;
    goldenJson: string;
    goldenCtBase64: string;
    goldenPtBase64: string;
  }) {
    await installAppleDnrRule(true);
    await ensureOffscreen();
    // 1. Check SW fetch to wrapper as reference
    let swWrapperResult: Record<string, unknown>;
    try {
      const r = await fetch(`${args.wrapperUrl}/status`);
      swWrapperResult = { ok: r.ok, status: r.status, body: await r.text() };
    } catch (err) {
      swWrapperResult = { ok: false, error: String(err) };
    }
    // 2. Ask offscreen to run (a) amp-api with DNR, (b) wrapper fetch, (c) worker + wasm
    const withDnr = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "m0-spike",
      ...args,
    });
    // 3. Control check: disable DNR rule and re-test amp-api from offscreen
    await installAppleDnrRule(false);
    const withoutDnr = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "m0-amp-check",
      songId: args.songId,
      storefront: args.storefront,
    });
    await installAppleDnrRule(true);
    return {
      extensionId: chrome.runtime.id,
      swWrapperResult,
      withDnr,
      withoutDnr,
    };
  },
};
