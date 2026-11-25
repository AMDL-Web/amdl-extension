/**
 * MAIN-world content script injected at `document_start` on music.apple.com.
 * Answers token requests from the isolated-world content script via a
 * per-request transferred `MessagePort` + random nonce so tokens are never
 * broadcast on `window` and never persisted.
 */

interface MusicKitInstanceLike {
  developerToken?: string;
  musicUserToken?: string;
  storefrontId?: string;
  isAuthorized?: boolean;
}

interface MusicKitGlobal {
  getInstance?: () => MusicKitInstanceLike | undefined;
}

function readPageTokens() {
  let developerToken = "";
  let musicUserToken = "";
  let storefrontId = "";

  try {
    const mk = (window as unknown as { MusicKit?: MusicKitGlobal }).MusicKit;
    const inst = mk?.getInstance?.();
    if (inst) {
      if (typeof inst.developerToken === "string") {
        developerToken = inst.developerToken;
      }
      if (typeof inst.musicUserToken === "string") {
        musicUserToken = inst.musicUserToken;
      }
      if (typeof inst.storefrontId === "string") {
        storefrontId = inst.storefrontId;
      }
    }
  } catch {
    // MusicKit may not be initialized yet.
  }

  const language = document.documentElement?.lang || navigator.language || "";
  return {
    ...(developerToken ? { developerToken } : {}),
    ...(musicUserToken ? { musicUserToken } : {}),
    ...(storefrontId ? { storefrontId } : {}),
    ...(language ? { language } : {}),
  };
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data as { type?: string; nonce?: string } | null;
  if (!data || data.type !== "amdl:token-req" || typeof data.nonce !== "string") {
    return;
  }
  const port = ev.ports?.[0];
  if (!port) return;
  port.postMessage({
    type: "amdl:token-res",
    nonce: data.nonce,
    tokens: readPageTokens(),
  });
  port.close();
});
