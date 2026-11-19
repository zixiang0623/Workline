// Web Push(RFC 8030 / VAPID RFC 8292 / 暗号化 RFC 8291 aes128gcm)を、Workers の WebCrypto だけで実装したもの。
// 外部ライブラリは使わない。シークレットは VAPID_PRIVATE_KEY(32バイトの秘密鍵 base64url)、公開鍵は VAPID_PUBLIC_KEY(65バイトの非圧縮点 base64url)。

const te = new TextEncoder();

export const b64uToBytes = (s) => {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export const bytesToB64u = (buf) => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// 購読の送り先は、主要なブラウザのプッシュサービスだけに限る(任意のURLへ送らせないため)
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.microsoft\.com$/];
export function validEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === "https:" && !u.username && !u.password && u.port === "" && PUSH_HOSTS.some((re) => re.test(u.hostname)) && endpoint.length <= 2048;
  } catch {
    return false;
  }
}

export const pushEnabled = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
export const publicKey = (env) => (env.VAPID_PUBLIC_KEY || "").trim();

let keyCache = { id: "", key: null };
async function signingKey(env) {
  const id = env.VAPID_PUBLIC_KEY + "|" + env.VAPID_PRIVATE_KEY.length;
  if (keyCache.id === id && keyCache.key) return keyCache.key;
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY は 65 バイトの非圧縮点(base64url)にしてください。");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY.trim(), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  keyCache = { id, key };
  return key;
}

// VAPID の JWT(ES256)。aud は送り先サービスのオリジン、exp は最大24時間先
export async function vapidHeader(env, endpoint, fallbackSubject) {
  const aud = new URL(endpoint).origin;
  const sub = (env.VAPID_SUBJECT || fallbackSubject || "mailto:workline@example.com").trim();
  const head = bytesToB64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env), te.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${publicKey(env)}`;
}

// RFC 8291: aes128gcm で本文を暗号化する。fixed はテスト用(通常は使わない)
export async function encryptPayload(sub, plain, fixed = {}) {
  const uaPub = b64uToBytes(sub.p256dh), authSecret = b64uToBytes(sub.auth);
  if (uaPub.length !== 65 || authSecret.length < 16) throw new Error("購読の鍵が正しくありません。");
  const eph = fixed.keyPair || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256);
  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));
  const hk = (secret, saltBytes, info, bits) =>
    crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]).then((k) => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: saltBytes, info }, k, bits));
  // IKM = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info\0" || ua_public || as_public)
  const ikm = new Uint8Array(await hk(ecdh, authSecret, concat(te.encode("WebPush: info\0"), uaPub, asPub), 256));
  const cek = await hk(ikm, salt, te.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hk(ikm, salt, te.encode("Content-Encoding: nonce\0"), 96);
  const data = concat(plain, new Uint8Array([2])); // 最後のレコードの区切り(0x02)
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, data));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // レコードサイズ 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

// 1件送る。戻り値: { ok, status, gone }。gone=true は購読が失効(404/410)で、保存を消してよい
export async function sendPush(env, sub, payload, opt = {}) {
  const body = await encryptPayload(sub, te.encode(JSON.stringify(payload)));
  const headers = {
    authorization: await vapidHeader(env, sub.endpoint, sub.origin),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(opt.ttl ?? 3600),
    urgency: opt.urgency || "normal",
  };
  if (opt.topic) headers.topic = String(opt.topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
