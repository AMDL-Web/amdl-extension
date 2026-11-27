/**
 * Extension-page localisation (popup, options) backed by chrome.i18n and
 * `_locales/{en,zh_CN,ja}/messages.json`. Content scripts follow the page
 * language instead (see src/content/i18n.ts).
 */
export function t(key: string, ...subs: Array<string | number>): string {
  try {
    const msg = chrome.i18n.getMessage(
      key,
      subs.map((s) => String(s)),
    );
    if (msg) return msg;
  } catch {
    // chrome.i18n unavailable (tests); fall through.
  }
  return key;
}

/**
 * Applies translations to elements marked with data-i18n (text),
 * data-i18n-placeholder, data-i18n-title and data-i18n-aria-label, and sets
 * <html lang> to the browser UI language.
 */
export function applyI18n(root: ParentNode = document): void {
  try {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  } catch {
    // ignore
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n!);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder!));
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.setAttribute("title", t(el.dataset.i18nTitle!));
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel!));
  }
}
