// AIの申告(名前・モデル・ドメイン)の整形と、アイコン画像の取得。
// Cloudflare固有のAPIには依存しない(Node.jsで単体テストできる)。

// 名前だけ申告されたときに、公式サイトのドメインを補う対応表(アイコン取得に使う)
const KNOWN_DOMAINS = {
  muse: "muse.ai",
  claude: "claude.ai",
  chatgpt: "chatgpt.com",
  gpt: "chatgpt.com",
  codex: "chatgpt.com",
  gemini: "gemini.google.com",
  copilot: "copilot.microsoft.com",
  grok: "grok.com",
  perplexity: "perplexity.ai",
  deepseek: "deepseek.com",
  cursor: "cursor.com",
};

const clip = (v, n) => (v === undefined || v === null ? "" : String(v)).slice(0, n);
const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

export const slugify = (name) =>
  String(name)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "ai";

// 外部へ取りに行ってよいホストか(IPアドレス直指定・ローカル系・ポート付きを除く)
export function isPublicHost(host) {
  const h = String(host || "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes(".") || h.startsWith(".") || h.endsWith(".")) return false;
  if (/^\d+(\.\d+){3}$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp|intranet|invalid|test|example)$/.test(h);
}

function cleanDomain(v) {
  if (!v) return "";
  const raw = String(v).trim();
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    return isPublicHost(host) ? host : "";
  } catch {
    return "";
  }
}

function cleanHttps(v) {
  if (!v) return "";
  try {
    const u = new URL(String(v).trim());
    return u.protocol === "https:" && isPublicHost(u.hostname) ? u.href.slice(0, 500) : "";
  } catch {
    return "";
  }
}

// 文字列(名前だけ)でもオブジェクトでも受け付ける。名前が無ければ null
export function parseAgent(x) {
  const o = typeof x === "string" ? { name: x } : x && typeof x === "object" && !Array.isArray(x) ? x : null;
  if (!o) return null;
  const name = clip(pick(o, "name", "agent", "ai"), 60).trim();
  if (!name) return null;
  const id = slugify(name);
  const tokens = id.split("-");
  const known = Object.keys(KNOWN_DOMAINS).find((k) => tokens.includes(k) || id.startsWith(k));
  return {
    id,
    name,
    vendor: clip(o.vendor, 60).trim(),
    model: clip(pick(o, "model", "modelName", "model_name"), 80).trim(),
    domain: cleanDomain(pick(o, "domain", "url", "website", "site")) || (known ? KNOWN_DOMAINS[known] : ""),
    iconUrl: cleanHttps(pick(o, "iconUrl", "icon_url", "icon")),
  };
}

/* ---------- アイコン取得 ---------- */

const IMG_MAX = 262144;

// 中身(先頭バイト)から画像の種類を判定する。Content-Typeは信用しない
export function sniffImage(buf) {
  if (!buf || buf.byteLength === 0 || buf.byteLength > IMG_MAX) return null;
  const b = new Uint8Array(buf.slice(0, 16));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 512))).toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}

async function safeFetch(url, accept, fetchImpl) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !isPublicHost(u.hostname)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetchImpl(u.href, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { accept, "user-agent": "Workline/1.0 (agent icon fetch)" },
    });
    if (!r.ok) return null;
    const final = new URL(r.url || u.href);
    if (final.protocol !== "https:" || !isPublicHost(final.hostname)) return null;
    return r;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// HTMLの<link>から、アイコン候補のURLを良い順に返す
export function iconLinksFromHtml(html, base) {
  const found = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = ((/\brel=["']([^"']+)["']/i.exec(tag) || [])[1] || "").toLowerCase();
    const href = (/\bhref=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href || !/icon/.test(rel) || /mask-icon/.test(rel)) continue;
    let abs;
    try {
      abs = new URL(href.replace(/&amp;/g, "&"), base).href;
    } catch {
      continue;
    }
    found.push({
      href: abs,
      apple: rel.includes("apple-touch-icon") ? 1 : 0,
      size: Number((/\bsizes=["'](\d+)x\d+["']/i.exec(tag) || [])[1]) || 0,
      modern: /\.(png|svg)(\?|$)/i.test(abs) ? 1 : 0,
    });
  }
  found.sort((a, b) => b.apple - a.apple || b.size - a.size || b.modern - a.modern);
  return found.map((f) => f.href);
}

// 申告されたアイコンURL → サイトのアイコン → /favicon.ico → 最後の手段(faviconサービス)の順に試す
export async function findIcon(agent, fetchImpl = fetch) {
  const tries = [];
  if (agent.icon_url) tries.push(agent.icon_url);
  if (agent.domain) {
    const page = await safeFetch(`https://${agent.domain}/`, "text/html", fetchImpl);
    if (page) {
      try {
        tries.push(...iconLinksFromHtml((await page.text()).slice(0, 200000), page.url || `https://${agent.domain}/`));
      } catch {}
    }
    tries.push(`https://${agent.domain}/favicon.ico`);
    tries.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(agent.domain)}&sz=128`);
  }
  for (const url of [...new Set(tries)].slice(0, 8)) {
    const r = await safeFetch(url, "image/*", fetchImpl);
    if (!r) continue;
    const buf = await r.arrayBuffer();
    const type = sniffImage(buf);
    if (type) return { type, buf };
  }
  return null;
}
