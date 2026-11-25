import type { LyricsExtra } from "./types.ts";

const APPLE_LYRICS_NS = "http://music.apple.com/lyric-ttml-internal";

interface LyricContent {
  text?: string;
  node?: LyricNode;
}

interface LyricNode {
  tag: string;
  attrs: Record<string, string>;
  content: LyricContent[];
  children: LyricNode[];
}

function isTTML(doc: string): boolean {
  return doc.trimStart().startsWith("<");
}

function decodeXmlEntities(s: string): string {
  return s.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (match, ent: string) => {
      switch (ent) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default: {
          if (ent.startsWith("#x")) {
            const cp = Number.parseInt(ent.slice(2), 16);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
          }
          if (ent.startsWith("#")) {
            const cp = Number.parseInt(ent.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
          }
          return match;
        }
      }
    },
  );
}

/**
 * Minimal strict XML parser matching Go's encoding/xml token semantics for TTML:
 * resolves XML namespace prefixes on attributes (storing both `nsURI:local` and
 * `prefix:local` so `attr()` matches both forms), rejects malformed/unclosed tags.
 */
function parseLyricsXml(raw: string): LyricNode | null {
  let i = 0;
  const n = raw.length;
  const stack: { node: LyricNode; ns: Record<string, string> }[] = [];
  let root: LyricNode | null = null;

  const parseTagName = (): string => {
    const start = i;
    while (
      i < n &&
      !/[\s/>=]/.test(raw[i]!)
    ) {
      i++;
    }
    return raw.slice(start, i);
  };

  const skipWs = () => {
    while (i < n && /\s/.test(raw[i]!)) i++;
  };

  const localName = (qname: string): string => {
    const colon = qname.indexOf(":");
    return colon >= 0 ? qname.slice(colon + 1) : qname;
  };

  while (i < n) {
    const lt = raw.indexOf("<", i);
    if (lt < 0) {
      const text = raw.slice(i);
      if (stack.length > 0 && text.length > 0) {
        stack[stack.length - 1]!.node.content.push({
          text: decodeXmlEntities(text),
        });
      }
      break;
    }
    if (lt > i) {
      const text = raw.slice(i, lt);
      if (stack.length > 0) {
        stack[stack.length - 1]!.node.content.push({
          text: decodeXmlEntities(text),
        });
      }
      i = lt;
    }

    // Comment <!-- ... -->
    if (raw.startsWith("<!--", i)) {
      const end = raw.indexOf("-->", i + 4);
      if (end < 0) throw new Error("unclosed XML comment");
      i = end + 3;
      continue;
    }
    // CDATA <![CDATA[ ... ]]>
    if (raw.startsWith("<![CDATA[", i)) {
      const end = raw.indexOf("]]>", i + 9);
      if (end < 0) throw new Error("unclosed CDATA");
      if (stack.length > 0) {
        stack[stack.length - 1]!.node.content.push({
          text: raw.slice(i + 9, end),
        });
      }
      i = end + 3;
      continue;
    }
    // Processing instruction <? ... ?>
    if (raw.startsWith("<?", i)) {
      const end = raw.indexOf("?>", i + 2);
      if (end < 0) throw new Error("unclosed processing instruction");
      i = end + 2;
      continue;
    }
    // DOCTYPE <!DOCTYPE ...>
    if (raw.startsWith("<!", i)) {
      const end = raw.indexOf(">", i + 2);
      if (end < 0) throw new Error("unclosed declaration");
      i = end + 1;
      continue;
    }
    // Closing tag </name>
    if (raw.startsWith("</", i)) {
      i += 2;
      const closeName = parseTagName();
      skipWs();
      if (i >= n || raw[i] !== ">") {
        throw new Error(`malformed closing tag </${closeName}`);
      }
      i++;
      if (stack.length === 0) {
        throw new Error(`unexpected closing tag </${closeName}>`);
      }
      const top = stack.pop()!;
      if (top.node.tag !== localName(closeName)) {
        throw new Error(
          `mismatched closing tag </${closeName}> for <${top.node.tag}>`,
        );
      }
      continue;
    }

    // Opening tag
    i++; // consume '<'
    const qname = parseTagName();
    if (!qname) throw new Error("empty XML tag name");

    const parentNs =
      stack.length > 0 ? stack[stack.length - 1]!.ns : ({} as Record<string, string>);
    const ns: Record<string, string> = { ...parentNs };
    const rawAttrs: [string, string][] = [];
    let selfClosing = false;

    while (i < n) {
      skipWs();
      if (i >= n) throw new Error(`unclosed start tag <${qname}`);
      if (raw.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (raw[i] === ">") {
        i++;
        break;
      }
      const attrName = parseTagName();
      if (!attrName) throw new Error(`invalid attribute in <${qname}>`);
      skipWs();
      if (raw[i] !== "=") throw new Error(`expected '=' after ${attrName}`);
      i++;
      skipWs();
      const quote = raw[i];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`expected quote for attribute ${attrName}`);
      }
      i++;
      const valStart = i;
      const valEnd = raw.indexOf(quote, valStart);
      if (valEnd < 0) throw new Error(`unclosed attribute value for ${attrName}`);
      const attrVal = decodeXmlEntities(raw.slice(valStart, valEnd));
      i = valEnd + 1;
      rawAttrs.push([attrName, attrVal]);
      if (attrName.startsWith("xmlns:")) {
        ns[attrName.slice(6)] = attrVal;
      }
    }

    const attrs: Record<string, string> = {};
    for (const [k, v] of rawAttrs) {
      const colon = k.indexOf(":");
      if (colon >= 0) {
        const prefix = k.slice(0, colon);
        const local = k.slice(colon + 1);
        const uri = ns[prefix];
        if (uri) {
          attrs[`${uri}:${local}`] = v;
        }
        attrs[k] = v;
      } else {
        attrs[k] = v;
      }
    }

    const node: LyricNode = {
      tag: localName(qname),
      attrs,
      content: [],
      children: [],
    };
    if (stack.length === 0) {
      root = node;
    } else {
      const parent = stack[stack.length - 1]!.node;
      parent.children.push(node);
      parent.content.push({ node });
    }
    if (!selfClosing) {
      stack.push({ node, ns });
    }
  }

  if (stack.length !== 0) {
    throw new Error("unclosed XML elements");
  }
  return root;
}

function attr(node: LyricNode | undefined, ...names: string[]): string {
  if (!node) return "";
  for (const name of names) {
    const v = node.attrs[name];
    if (v !== undefined) return v;
    if (name.startsWith("itunes:")) {
      const expanded = `${APPLE_LYRICS_NS}:${name.slice("itunes:".length)}`;
      const ev = node.attrs[expanded];
      if (ev !== undefined) return ev;
    }
  }
  return "";
}

function untimedTTML(root: LyricNode): boolean {
  return attr(root, "itunes:timing", "timing").toLowerCase() === "none";
}

function findNodes(root: LyricNode | undefined, tag: string): LyricNode[] {
  const out: LyricNode[] = [];
  const walk = (node: LyricNode | undefined) => {
    if (!node) return;
    if (node.tag === tag) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function lyricParagraphs(root: LyricNode): LyricNode[] {
  const out: LyricNode[] = [];
  const walk = (node: LyricNode, inBody: boolean) => {
    const body = inBody || node.tag === "body";
    if (body && node.tag === "p") {
      out.push(node);
      return;
    }
    for (const child of node.children) walk(child, body);
  };
  walk(root, false);
  return out;
}

function nodeText(node: LyricNode | undefined): string {
  const parts: string[] = [];
  const write = (n: LyricNode | undefined) => {
    if (!n) return;
    for (const c of n.content) {
      if (c.node) write(c.node);
      else if (c.text !== undefined) parts.push(c.text);
    }
  };
  write(node);
  return parts.join("").trim();
}

function preferredNodeText(node: LyricNode): string {
  const textAttr = attr(node, "text");
  if (textAttr !== "") return textAttr;
  return nodeText(node);
}

function collapseSpace(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/).join(" ");
}

function lineText(node: LyricNode | undefined): string {
  if (!node) return "";
  return collapseSpace(preferredNodeText(node));
}

function firstSpanBegin(node: LyricNode): string {
  for (const span of findNodes(node, "span")) {
    const begin = attr(span, "begin");
    if (begin !== "") return begin;
  }
  return "";
}

function localizedLines(
  root: LyricNode,
  section: string,
): Map<string, LyricNode> {
  const lines = new Map<string, LyricNode>();
  for (const group of findNodes(root, section)) {
    for (const text of findNodes(group, "text")) {
      const key = attr(text, "for");
      if (key !== "" && !lines.has(key)) {
        lines.set(key, text);
      }
    }
  }
  return lines;
}

function plainTextLyrics(root: LyricNode): string {
  const lines: string[] = [];
  for (const p of findNodes(root, "p")) {
    const text = lineText(p);
    if (text !== "") lines.push(text);
  }
  return lines.join("\n");
}

function left2(i: number): string {
  return i < 10 ? `0${i}` : String(i);
}

function rightPad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + "0".repeat(len - s.length);
}

function parseIntStrict(s: string): number {
  if (!/^\d+$/.test(s)) {
    throw new Error(`invalid integer "${s}" in lyrics timestamp`);
  }
  return Number.parseInt(s, 10);
}

export function lrcTime(raw: string): string {
  let v = raw;
  if (!v.includes(".")) {
    v += ".000";
  }
  const parts = v.split(":");
  let h = 0;
  let m = 0;
  const secPart = parts[parts.length - 1] ?? "";
  if (parts.length === 3) {
    h = parseIntStrict(parts[0]!);
    m = parseIntStrict(parts[1]!);
  } else if (parts.length === 2) {
    m = parseIntStrict(parts[0]!);
  } else if (parts.length > 3) {
    throw new Error(`invalid lyrics timestamp "${raw}"`);
  }
  const dot = secPart.indexOf(".");
  const sStr = dot >= 0 ? secPart.slice(0, dot) : secPart;
  const msStr = dot >= 0 ? secPart.slice(dot + 1) : "";
  const s = parseIntStrict(sStr);
  const ms = msStr ? parseIntStrict(rightPad(msStr, 3)) : 0;
  const totalM = h * 60 + m;
  return `${left2(totalM)}:${left2(s)}.${left2(Math.floor(ms / 10))}`;
}

function lrcLine(node: LyricNode, word: boolean): string {
  if (!word || firstSpanBegin(node) === "") {
    return lineText(node);
  }
  const parts: string[] = [];
  let end = "";
  const walk = (n: LyricNode) => {
    for (const c of n.content) {
      if (!c.node) {
        if (c.text !== undefined) parts.push(c.text);
        continue;
      }
      const child = c.node;
      const begin = attr(child, "begin");
      if (child.tag !== "span" || begin === "") {
        walk(child);
        continue;
      }
      const stamp = lrcTime(begin);
      parts.push(`<${stamp}>${preferredNodeText(child)}`);
      const e = attr(child, "end");
      if (e !== "") end = e;
    }
  };
  walk(node);
  let line = collapseSpace(parts.join(""));
  if (end !== "") {
    line += `<${lrcTime(end)}>`;
  }
  return line;
}

/**
 * Renders an Apple Music TTML lyrics document (or plain text) into LRC format.
 * 1:1 port of Go `experiments/browser/engine/lyrics.go#lyricsLRC`.
 */
export function lyricsLrc(
  doc: string,
  word = false,
  extras: readonly LyricsExtra[] = [],
): string {
  if (!isTTML(doc)) {
    return doc.trim();
  }
  let root: LyricNode | null;
  try {
    root = parseLyricsXml(doc);
  } catch (err) {
    throw new Error(
      `parse lyrics TTML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!root) {
    throw new Error("parse lyrics TTML: empty document");
  }
  if (untimedTTML(root)) {
    return plainTextLyrics(root);
  }

  const translations = extras.includes("translation")
    ? localizedLines(root, "translations")
    : new Map<string, LyricNode>();
  const romanizations = extras.includes("pronunciation")
    ? localizedLines(root, "transliterations")
    : new Map<string, LyricNode>();

  const lines: string[] = [];
  for (const p of lyricParagraphs(root)) {
    const text = lineText(p);
    if (text === "") continue;
    const begin = attr(p, "begin") || firstSpanBegin(p);
    if (begin === "") {
      throw new Error("no synchronised lyrics");
    }
    const prefix = `[${lrcTime(begin)}]`;
    lines.push(prefix + lrcLine(p, word));

    const key = attr(p, "itunes:key", "key");
    const trNode = translations.get(key);
    const translation = lineText(trNode);
    if (
      translation !== "" &&
      translation.toLowerCase() !== text.toLowerCase()
    ) {
      lines.push(prefix + translation);
    }
    const romNode = romanizations.get(key);
    const romanized = lineText(romNode);
    if (
      romNode &&
      romanized !== "" &&
      romanized.toLowerCase() !== text.toLowerCase()
    ) {
      lines.push(prefix + lrcLine(romNode, word));
    }
  }
  return lines.join("\n");
}
