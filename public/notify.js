/* Workline 通知 + PWA (v2.3)
 * どの画面からも <script src="/notify.js" defer></script> で読み込む。使い方:
 *   WLNotify.mount({ before: '#soundBtn', cls: 'btn quiet' })   // ヘッダーにベルのボタンを足す(押すと設定ダイアログ)
 *   WLNotify.onMessage(msg)                                      // WebSocket で届いた JSON を渡す(画面を閉じている間はサーバーの Web Push が代わりに知らせる)
 * 通知は 2 段構え: サーバーに VAPID キーがあれば Web Push(閉じていても届く) / 無ければ、このページが開いている間だけのローカル通知。
 */
(() => {
  'use strict';
  const KINDS = [
    ['approval', '確認待ち', 'AIが、あなたの返事を待っているとき'],
    ['note', 'AIからの伝言', 'AIが、あなた宛て(または全員宛て)に伝言を書いたとき'],
    ['done', '完了', 'セッション(ルートのタスク)が完了したとき'],
    ['failed', '失敗・中断', 'セッションが失敗または中断で終わったとき'],
  ];
  const ICON = {
    bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    'bell-off': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    'smartphone': '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };
  const svg = (n) => `<svg class="wln-ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('workline.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('workline.' + k, v); } catch {} },
  };
  const token = () => ls.get('token', '');
  const authHeaders = () => (token() ? { authorization: 'Bearer ' + token() } : {});
  const b64uToBytes = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const N = {
    reg: null, sub: null, srv: { enabled: false, publicKey: '', subscribed: false, prefs: { approval: true, note: true, done: true, failed: true }, devices: 0 },
    local: ls.get('notify.local', '0') === '1', installEvt: null, btn: null, dlg: null, busy: false, msg: '', err: false,
    mem: { tasks: new Map(), approvals: new Set(), noteMax: 0, agents: new Map(), ready: false },
  };

  /* ---------- state ---------- */
  const permission = () => ('Notification' in window ? Notification.permission : 'unsupported');
  const pushOn = () => !!(N.sub && N.srv.subscribed);
  const active = () => permission() === 'granted' && (pushOn() || N.local);

  async function api(method, body) {
    const q = method === 'GET' ? '?endpoint=' + encodeURIComponent((N.sub && N.sub.endpoint) || '') : '';
    const r = await fetch('/api/push' + q, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...authHeaders() }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'http ' + r.status);
    return j;
  }
  async function refresh() {
    try {
      if (N.reg && canPush()) N.sub = await N.reg.pushManager.getSubscription();
      N.srv = await api('GET');
      if (N.sub && !N.srv.subscribed && N.srv.enabled) { // 端末には購読があるのにサーバーに無い(リセットなど): 登録し直す
        N.srv = await api('POST', { action: 'subscribe', subscription: N.sub.toJSON() });
      }
      if (N.reg && N.reg.active) N.reg.active.postMessage({ type: 'workline-auth', token: token(), key: N.srv.publicKey });
    } catch {}
    paintBtn();
  }

  /* ---------- actions ---------- */
  async function enable() {
    N.busy = true; N.msg = ''; N.err = false; paintDlg();
    try {
      if (!('Notification' in window)) throw new Error('このブラウザは通知に対応していません。');
      const p = permission() === 'granted' ? 'granted' : await Notification.requestPermission();
      if (p !== 'granted') throw new Error(p === 'denied' ? '通知がブロックされています。ブラウザのサイト設定で許可してください。' : '通知は許可されませんでした。');
      await refresh();
      if (N.srv.enabled && canPush() && N.reg) {
        const sub = N.sub || (await N.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(N.srv.publicKey) }));
        N.sub = sub;
        N.srv = await api('POST', { action: 'subscribe', subscription: sub.toJSON(), prefs: N.srv.prefs });
        if (N.reg.active) N.reg.active.postMessage({ type: 'workline-auth', token: token(), key: N.srv.publicKey });
        N.local = false; ls.set('notify.local', '0');
        N.msg = 'オンにしました。画面を閉じていても通知が届きます。';
      } else {
        N.local = true; ls.set('notify.local', '1');
        N.msg = 'オンにしました。サーバーに通知の鍵が無いため、この画面を開いている間だけ通知します。';
      }
    } catch (e) { N.err = true; N.msg = String(e.message || e); }
    N.busy = false; paintBtn(); paintDlg();
  }
  async function disable() {
    N.busy = true; N.msg = ''; N.err = false; paintDlg();
    try {
      if (N.sub) { const ep = N.sub.endpoint; await N.sub.unsubscribe().catch(() => {}); N.sub = null; await api('POST', { action: 'unsubscribe', endpoint: ep }).catch(() => {}); }
      N.local = false; ls.set('notify.local', '0'); await refresh();
      N.msg = 'オフにしました。';
    } catch (e) { N.err = true; N.msg = String(e.message || e); }
    N.busy = false; paintBtn(); paintDlg();
  }
  async function setPref(k, v) {
    N.srv.prefs[k] = v; ls.set('notify.pref.' + k, v ? '1' : '0'); paintDlg();
    if (pushOn()) { try { N.srv = await api('POST', { action: 'prefs', endpoint: N.sub.endpoint, prefs: { [k]: v } }); } catch (e) { N.err = true; N.msg = String(e.message || e); } paintDlg(); }
  }
  async function test() {
    N.busy = true; N.msg = ''; N.err = false; paintDlg();
    try {
      if (pushOn()) { await api('POST', { action: 'test', endpoint: N.sub.endpoint }); N.msg = 'テスト通知を送りました。数秒で届きます。'; }
      else { await show({ kind: 'test', title: 'Workline のテスト通知', body: 'この通知が見えていれば、設定は完了です。', tag: 'workline-test', url: '/' }); N.msg = 'テスト通知を出しました。'; }
    } catch (e) { N.err = true; N.msg = String(e.message || e); }
    N.busy = false; paintDlg();
  }
  async function install() {
    const e = N.installEvt; if (!e) return;
    e.prompt(); try { await e.userChoice; } catch {}
    N.installEvt = null; paintDlg();
  }

  /* ---------- local notifications (fallback, and the page's own events) ---------- */
  async function show(p) {
    const opt = { body: p.body || '', tag: p.tag || undefined, renotify: !!p.tag, icon: '/icon-192.png', badge: '/favicon-32.png', data: { url: p.url || '/', kind: p.kind || '' }, requireInteraction: p.kind === 'approval' };
    if (N.reg) return N.reg.showNotification(p.title, opt);
    return new Notification(p.title, opt);
  }
  function local(kind, p) {
    if (!active() || pushOn() || !document.hidden) return; // サーバーのプッシュが有効なら重複させない。見ている間は画面の表示で足りる
    if (ls.get('notify.pref.' + kind, '1') === '0') return;
    show({ kind, ...p }).catch(() => {});
  }

  /* WebSocket のメッセージから、通知する出来事を見つける(スナップショットは基準になるだけで通知しない) */
  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    const M = N.mem;
    if (m.t === 'purged') { M.tasks.clear(); M.approvals.clear(); M.noteMax = 0; badge(); return; }
    if (m.t === 'snapshot') {
      for (const a of m.agents || []) M.agents.set(a.id, a.name);
      M.tasks = new Map((m.tasks || []).map((t) => [t.id, t.status]));
      M.approvals = new Set((m.approvals || []).map((a) => a.requestId));
      M.noteMax = Math.max(0, ...(m.notes || []).map((n) => n.noteId));
      M.pending = (m.approvals || []).filter((a) => a.status === 'pending').length; M.ready = true; badge(); return;
    }
    if (!M.ready) return;
    const name = (id) => M.agents.get(id) || id || 'AI';
    if (m.t === 'patch' && m.task) {
      if (m.agent) M.agents.set(m.agent.id, m.agent.name);
      const t = m.task, prev = M.tasks.get(t.id); M.tasks.set(t.id, t.status);
      if (prev === 'running' && t.status !== 'running' && t.parentId == null) {
        const label = { done: '完了', failed: '失敗', cancelled: '中断' }[t.status] || '終了';
        local(t.status === 'done' ? 'done' : 'failed', { title: `${label}: ${t.title}`, body: name(t.agent), tag: `task-${t.id}`, url: `/#t=${t.id}` });
      }
    } else if (m.t === 'approval' && m.approval) {
      const a = m.approval, isNew = !M.approvals.has(a.requestId); M.approvals.add(a.requestId);
      M.pending = (M.pending || 0) + (isNew && a.status === 'pending' ? 1 : 0); // 件数は下で数え直す
      if (isNew && a.status === 'pending') local('approval', { title: `確認待ち: ${a.question.slice(0, 60)}`, body: `${name(a.from)} が回答を待っています`, tag: `approval-${a.requestId}`, url: `/#t=${a.taskId}` });
      N.pendingIds = N.pendingIds || new Map(); N.pendingIds.set(a.requestId, a.status === 'pending'); M.pending = [...N.pendingIds.values()].filter(Boolean).length; badge();
    } else if (m.t === 'note' && m.note) {
      const n = m.note;
      if (n.noteId > M.noteMax) { M.noteMax = n.noteId; if (n.from !== 'user' && (n.toAll || (n.to || []).includes('user'))) local('note', { title: `${name(n.from)} からの伝言`, body: (n.body || '').slice(0, 120), tag: `note-${n.noteId}`, url: n.taskId ? `/#t=${n.taskId}` : '/' }); }
    }
  }
  // 確認待ちの数を、ホーム画面のアイコン(PWA)にバッジで出す
  function badge() {
    const n = N.mem.pending || 0;
    try { if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n); else if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch {}
  }

  /* ---------- UI ---------- */
  const CSS = `
.wln-ic{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.wln-btn{position:relative}
.wln-btn[data-on="1"]{color:var(--color-accent,#e8a06a)}
.wln-dlg{width:min(30rem,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--color-rule,#3a342c);border-radius:0;background:var(--color-paper,#14110d);color:var(--color-ink,#f2ede4);font:inherit;overflow:auto}
.wln-dlg::backdrop{background:rgba(0,0,0,.6)}
.wln-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--color-rule,#3a342c)}
.wln-head h2{margin:0;flex:1;font-size:1.05rem;font-weight:500;display:flex;gap:8px;align-items:center}
.wln-body{display:flex;flex-direction:column;gap:16px;padding:16px}
.wln-sec{display:flex;flex-direction:column;gap:8px}
.wln-sec>h3{margin:0;font-size:.8125rem;font-weight:500;color:var(--color-muted,#a79f92)}
.wln-state{display:flex;align-items:center;gap:8px;font-size:.9375rem}
.wln-p{margin:0;font-size:.8125rem;line-height:1.6;color:var(--color-muted,#a79f92)}
.wln-row{display:flex;flex-wrap:wrap;gap:8px}
.wln-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 14px;border:1px solid var(--color-rule,#3a342c);border-radius:0;background:transparent;color:inherit;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;transition:background-color .12s,transform .12s}
.wln-b:hover{background:var(--color-paper-2,#1d1914)}.wln-b:active{transform:scale(.97)}
.wln-b.pri{background:var(--color-accent,#e8a06a);border-color:var(--color-accent,#e8a06a);color:var(--color-accent-ink,#1a1006)}
.wln-b[disabled]{opacity:.5;cursor:not-allowed}
.wln-b:focus-visible,.wln-t input:focus-visible+span{outline:2px solid var(--color-focus,#f0b98a);outline-offset:2px}
.wln-t{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:1px solid var(--color-rule,#3a342c);cursor:pointer}
.wln-t input{position:absolute;opacity:0;pointer-events:none}
.wln-t .bx{flex:none;width:18px;height:18px;margin-top:2px;border:1px solid var(--color-muted,#a79f92);display:grid;place-items:center;color:transparent}
.wln-t input:checked+.bx{background:var(--color-accent,#e8a06a);border-color:var(--color-accent,#e8a06a);color:var(--color-accent-ink,#1a1006)}
.wln-t b{display:block;font-size:.9375rem;font-weight:500}.wln-t small{display:block;font-size:.75rem;color:var(--color-muted,#a79f92)}
.wln-t[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
.wln-msg{display:flex;gap:8px;align-items:flex-start;font-size:.8125rem;line-height:1.55;padding:10px 12px;border:1px solid var(--color-rule,#3a342c)}
.wln-msg[data-err]{color:var(--color-error,#f08a7a);border-color:currentColor}
.wln-x{min-height:36px;padding:0 10px}
/* 本体と同じ部品を持つ画面(--radius-ctl がある画面)だけ、本体のダイアログ・ボタンと同じ見た目にする。/beta はそのまま */
[data-wln="app"] .wln-ic{stroke-width:2}
.wln-dlg[data-wln="app"]{border:var(--rule-hair,1px) solid var(--color-rule);border-radius:var(--radius-card);background:var(--color-paper);color:var(--color-ink);box-shadow:var(--shadow-sheet)}
.wln-dlg[data-wln="app"]::backdrop{background:var(--color-scrim)}
.wln-dlg[data-wln="app"] .wln-head{padding:var(--space-md) var(--space-lg);border-bottom:0}
.wln-dlg[data-wln="app"] .wln-head h2{font-size:var(--text-lg);font-weight:700}
.wln-dlg[data-wln="app"] .wln-body{padding:0 var(--space-lg) var(--space-lg)}
.wln-dlg[data-wln="app"] .wln-sec>h3{font-size:var(--text-xs);color:var(--color-muted)}
.wln-dlg[data-wln="app"] .wln-state{font-size:var(--text-md)}
.wln-dlg[data-wln="app"] .wln-p{font-size:var(--text-xs);color:var(--color-muted)}
.wln-dlg[data-wln="app"] .wln-b{border:var(--rule-hair,1px) solid var(--color-rule);border-radius:var(--radius-ctl);background:var(--color-paper);color:var(--color-ink);font-size:var(--text-sm);font-weight:400;transition:background var(--dur-micro),transform var(--dur-micro) var(--ease-out)}
.wln-dlg[data-wln="app"] .wln-b:hover{background:var(--color-paper-3)}
.wln-dlg[data-wln="app"] .wln-b.pri{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-accent-ink)}
.wln-dlg[data-wln="app"] .wln-b.pri:hover{background:color-mix(in oklab,var(--color-accent) 88%,var(--color-ink))}
.wln-dlg[data-wln="app"] .wln-x{width:40px;min-height:40px;padding:0;border:0;background:transparent;color:var(--color-ink-2)}
.wln-dlg[data-wln="app"] .wln-x:hover{background:var(--color-paper-3);color:var(--color-ink)}
.wln-dlg[data-wln="app"] .wln-t{border:var(--rule-hair,1px) solid var(--color-rule);border-radius:var(--radius-ctl);background:var(--color-paper)}
.wln-dlg[data-wln="app"] .wln-t .bx{border-radius:6px;border-color:var(--color-muted)}
.wln-dlg[data-wln="app"] .wln-t b{font-size:var(--text-sm)}
.wln-dlg[data-wln="app"] .wln-msg{border-radius:var(--radius-ctl);background:var(--color-paper-2);font-size:var(--text-sm)}
.wln-dlg[data-wln="app"] .wln-msg[data-err]{background:var(--color-error-soft);border-color:var(--color-error);color:var(--color-error)}
.wln-btn[data-wln="app"][data-on="1"]{box-shadow:inset 0 0 0 var(--rule-hair,1px) var(--color-accent)}
@media (prefers-reduced-motion:reduce){.wln-b{transition:none}}
`;
  const isApp = () => !!getComputedStyle(document.documentElement).getPropertyValue('--radius-ctl').trim();
  function ensureCss() { if (document.getElementById('wln-css')) return; const s = document.createElement('style'); s.id = 'wln-css'; s.textContent = CSS; document.head.appendChild(s); }

  function paintBtn() {
    if (!N.btn) return;
    const on = active();
    N.btn.dataset.on = on ? '1' : '0';
    N.btn.setAttribute('aria-label', on ? '通知の設定(オン)' : '通知の設定(オフ)');
    N.btn.title = on ? '通知はオンです' : '通知をオンにする';
    N.btn.innerHTML = svg(on ? 'bell' : 'bell-off');
  }
  function paintDlg() {
    if (!N.dlg) return;
    const perm = permission(), on = active(), needInstall = isIOS && !standalone();
    const mode = pushOn() ? 'push' : N.local ? 'local' : 'off';
    const stateTxt = perm === 'unsupported' ? 'このブラウザは通知に対応していません' : perm === 'denied' ? 'ブラウザで通知がブロックされています' : on ? (mode === 'push' ? 'オン(画面を閉じていても届きます)' : 'オン(この画面を開いている間だけ)') : 'オフ';
    const toggles = KINDS.map(([k, label, hint]) => `<label class="wln-t" ${on ? '' : 'aria-disabled="true"'}><input type="checkbox" data-pref="${k}" ${N.srv.prefs[k] !== false ? 'checked' : ''} ${on ? '' : 'disabled'}><span class="bx">${svg('circle-check').replace('wln-ic', 'wln-ic" style="width:14px;height:14px')}</span><span><b>${label}</b><small>${hint}</small></span></label>`).join('');
    N.dlg.querySelector('.wln-body').innerHTML = `
      <div class="wln-sec"><div class="wln-state">${svg(on ? 'bell' : 'bell-off')}<span>${esc(stateTxt)}</span></div>
        ${needInstall ? `<div class="wln-msg">${svg('smartphone')}<span>iPhone・iPad では、共有メニューの「ホーム画面に追加」でインストールしてから、そのアイコンを開いて通知をオンにしてください(iOS の仕様です)。</span></div>` : ''}
        ${perm === 'denied' ? `<div class="wln-msg" data-err>${svg('triangle-alert')}<span>ブラウザのサイト設定で、この画面の通知を「許可」にしてから、もう一度オンにしてください。</span></div>` : ''}
        ${!N.srv.enabled && !needInstall && perm !== 'unsupported' ? `<p class="wln-p">サーバーに通知の鍵(VAPID)が設定されていないため、画面を開いている間だけ通知できます。閉じていても届くようにするには、README の「通知(Web Push)」の手順で鍵を設定してください。</p>` : ''}
        <div class="wln-row">
          ${on ? `<button class="wln-b" type="button" data-act="off" ${N.busy ? 'disabled' : ''}>${svg('bell-off')}<span>オフにする</span></button><button class="wln-b" type="button" data-act="test" ${N.busy ? 'disabled' : ''}>${svg('send')}<span>テスト通知</span></button>`
                  : `<button class="wln-b pri" type="button" data-act="on" ${N.busy || needInstall || perm === 'unsupported' || perm === 'denied' ? 'disabled' : ''}>${svg('bell')}<span>通知をオンにする</span></button>`}
        </div>
        ${N.msg ? `<div class="wln-msg" ${N.err ? 'data-err' : ''} role="status">${svg(N.err ? 'triangle-alert' : 'circle-check')}<span>${esc(N.msg)}</span></div>` : ''}
      </div>
      <div class="wln-sec"><h3>受け取る通知</h3>${toggles}<p class="wln-p">${N.srv.devices ? `通知に登録されている端末: ${N.srv.devices} 台。` : ''}選んだ種類は、この端末だけに効きます。</p></div>
      ${N.installEvt ? `<div class="wln-sec"><h3>アプリとして使う</h3><p class="wln-p">ホーム画面やDockに追加すると、独立したウィンドウで開き、未対応の確認の数をアイコンに表示します。</p><div class="wln-row"><button class="wln-b" type="button" data-act="install">${svg('download')}<span>インストール</span></button></div></div>` : ''}`;
  }
  function buildDlg() {
    if (N.dlg) return;
    ensureCss();
    const d = document.createElement('dialog'); d.className = 'wln-dlg'; if (isApp()) d.dataset.wln = 'app'; d.setAttribute('aria-labelledby', 'wlnTitle');
    d.innerHTML = `<div class="wln-head"><h2 id="wlnTitle">${svg('bell')}<span>通知</span></h2><button class="wln-b wln-x" type="button" data-act="close" aria-label="閉じる">${svg('x')}</button></div><div class="wln-body"></div>`;
    d.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) { const k = a.dataset.act; if (k === 'close') d.close(); else if (k === 'on') enable(); else if (k === 'off') disable(); else if (k === 'test') test(); else if (k === 'install') install(); return; }
      if (e.target === d) d.close();
    });
    d.addEventListener('change', (e) => { const i = e.target.closest('[data-pref]'); if (i) setPref(i.dataset.pref, i.checked); });
    document.body.appendChild(d); N.dlg = d;
  }
  function open() { buildDlg(); N.msg = ''; N.err = false; paintDlg(); if (!N.dlg.open) N.dlg.showModal(); refresh().then(paintDlg); }

  function mount({ before, after, cls = 'btn quiet' } = {}) {
    ensureCss();
    if (N.btn) return N.btn;
    const b = document.createElement('button'); b.type = 'button'; b.className = cls + ' wln-btn'; b.id = 'wlnBtn'; b.dataset.label = '通知'; if (isApp()) b.dataset.wln = 'app'; b.addEventListener('click', open);
    N.btn = b; paintBtn();
    const ref = document.querySelector(before || after || '');
    if (ref) ref.parentNode.insertBefore(b, before ? ref : ref.nextSibling); else (document.querySelector('header') || document.body).appendChild(b);
    return b;
  }

  /* ---------- boot ---------- */
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); N.installEvt = e; paintDlg(); });
  addEventListener('appinstalled', () => { N.installEvt = null; paintDlg(); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'workline-open') { if (d.hash && d.hash !== location.hash && (!d.path || d.path === location.pathname || d.path === '/')) location.hash = d.hash; }
    });
    navigator.serviceWorker.register('/sw.js').then(async () => { N.reg = await navigator.serviceWorker.ready; await refresh(); }).catch(() => {});
  } else refresh();
  window.WLNotify = { mount, open, onMessage, refresh, state: N };
})();
