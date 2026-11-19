/* Workline service worker (v2.3)
 * - PWA: ホーム画面に追加できるようにし、通信できないときは最後に見た画面を出す(API・WebSocket・画像は一切キャッシュしない)
 * - 通知: Web Push を受け取って表示する。画面を見ているときは、通知を出さずに画面へ知らせるだけにする(iOS は常に出す必要がある)
 */
const SHELL = 'workline-shell-v2.3';
const IDB = 'workline-sw';

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open(IDB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const kvGet = async (k) => { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; } };
const kvSet = async (k, v) => { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch {} };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('workline-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* ---------- offline shell: 画面(HTML)だけ、通信できないときの予備に ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.mode !== 'navigate') return;
  const key = url.origin + url.pathname; // ?token= は保存しない
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) (await caches.open(SHELL)).put(key, res.clone());
      return res;
    } catch {
      return (await caches.match(key)) || (await caches.match(url.origin + '/')) || new Response('オフラインです。通信が戻ると、自動でつながります。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});

/* ---------- push ---------- */
const isApple = /iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent) && 'ontouchend' in self; // iOS/iPadOS は、通知を出さない push を許さない

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'Workline', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const watching = wins.some((c) => c.visibilityState === 'visible' && c.focused !== false);
    for (const c of wins) c.postMessage({ type: 'workline-push', payload: p });
    if (watching && !isApple && p.kind !== 'test') return; // 見ている人には、画面側の表示と音で十分
    const urgent = p.urgency === 'high';
    await self.registration.showNotification(p.title || 'Workline', {
      body: p.body || '',
      tag: p.tag || undefined,
      renotify: !!p.tag,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      timestamp: Date.now(),
      requireInteraction: p.kind === 'approval', // 確認待ちは、気づくまで残す(対応する環境のみ)
      data: { url: p.url || '/', kind: p.kind || '', taskId: p.taskId ?? null },
      vibrate: urgent ? [120, 60, 120] : undefined,
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', location.origin);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find((c) => new URL(c.url).origin === location.origin);
    if (same) {
      await same.focus();
      same.postMessage({ type: 'workline-open', hash: target.hash, path: target.pathname }); // 画面側で、そのタスクを開く
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

/* ---------- 購読が切れたとき、自動でつなぎ直す ---------- */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'workline-auth') e.waitUntil(kvSet('auth', { token: d.token || '', key: d.key || '' })); // 再購読のために、閲覧トークンと公開鍵を預かる
});
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const auth = (await kvGet('auth')) || {};
    const key = auth.key || (e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey);
    if (!key) return;
    try {
      const sub = e.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: 'Bearer ' + auth.token } : {}) },
        body: JSON.stringify({ action: 'subscribe', subscription: sub.toJSON() }),
      });
    } catch {}
  })());
});
