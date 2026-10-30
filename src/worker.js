// Workline: AIの作業をリアルタイムで見せるMCPサーバー + ビューアー配信
// 構成: Worker(ルーティング/MCP) + Durable Object "Board"(SQLite保存 + WebSocket配信)
import { DurableObject } from "cloudflare:workers";
import { findIcon, parseAgent } from "./agents.js";

const VERSION = "1.2.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const KINDS = ["plan", "think", "search", "read", "write", "run", "web", "check", "fix", "wait", "note"];
const STEP_STATUS = ["running", "done", "failed", "skipped"];
const TASK_END = ["done", "failed", "cancelled"];

const LIMIT = { title: 200, summary: 1000, detail: 6000, line: 300 };
const MAX_STEPS_PER_TASK = 2000;
const KEEP_TASKS = 100;
const KEEP_DAYS = 30;
const SNAPSHOT_TASKS = 20;
const SNAPSHOT_STEPS = 400;

const INSTRUCTIONS = `Workline は、人間が別画面でリアルタイムに眺めている「AIの作業ログ」です。
あなた(AI)がいま何をしているかを、できるだけ細かく、その場で送ってください。

複数のAIが同じ画面に送ることがあります。startTask の agent で、あなた自身の名前とモデルを必ず申告してください(画面に名前とアイコンが出ます)。

使い方のルール
0. 自分の名前(例: Muse, Claude, ChatGPT)と、分かればモデル名を、startTask の agent に入れる。別のAI(サブエージェントなど)の作業を記録するときは、addStep の agent にそのAIの名前を入れる。
1. 作業に取りかかる最初に startTask を1回呼ぶ。
2. 小さな行動ひとつごとに addStep を呼ぶ(ファイルを読む、検索する、コマンドを実行する、編集する、確認する、方針を考える、待つ)。後でまとめて送らない。
3. 時間がかかる行動は、始める時に status="running" で addStep し、終わったら updateStep で "done" か "failed" にする。すぐ終わる行動は status を省略して1回で送る。
4. 長く黙る前後には setStatus で「いまやっていること(now)」と「次にやること(next)」を更新する。
5. 作業が終わったら(失敗・中断も)必ず finishTask を呼ぶ。
6. title は人間が読む短い日本語(40文字以内目安)。補足・コマンド・結果の要約は detail に書く。
7. パスワード、トークン、APIキーなどの秘密情報は title/detail に絶対に書かない。
8. taskId や stepId を忘れたら listTasks で確認できる。taskId を省略すると最新の実行中タスクが対象になる。`;

const AGENT_SCHEMA = {
  type: "object",
  description: "あなた自身(AI)の申告。画面に名前とアイコンが表示される",
  properties: {
    name: { type: "string", description: "AIの名前(例: Muse, Claude, ChatGPT)" },
    model: { type: "string", description: "モデル名(分かる場合。例: Muse Spark 1.3)" },
    domain: { type: "string", description: "アイコン取得用の公式サイトのドメイン(例: muse.ai)。有名なAIなら省略可" },
    iconUrl: { type: "string", description: "アイコン画像の https URL(任意)" },
  },
  required: ["name"],
};

const TOOLS = [
  {
    name: "startTask",
    title: "作業を開始する",
    description:
      "新しい作業(タスク)の記録を始める。作業に取りかかる最初に必ず1回呼ぶ。agent で自分(AI)の名前を申告する。戻り値の taskId は以降省略可(省略時は最新の実行中タスクが対象)。plan を渡すと予定チェックリストが表示され、addStep の planIndex で自動的に進行状況が更新される。",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT_SCHEMA,
        title: { type: "string", description: "作業のタイトル(例: noVNCをChromeで試す)" },
        summary: { type: "string", description: "何のための作業か、1〜2文で" },
        plan: { type: "array", items: { type: "string" }, description: "予定の手順(任意、最大30件)" },
      },
      required: ["agent", "title"],
    },
    annotations: { title: "作業を開始する", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "addStep",
    title: "ステップを記録する",
    description:
      "作業の1ステップを記録する。ファイルを読む/検索/実行/編集/確認/考える/待つ、など小さな行動のたびに呼ぶ(まとめ送りしない)。時間がかかる行動は status=running で送り、終わったら updateStep で完了にする。すぐ終わる行動は status を省略(=done)して1回で送る。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "integer", description: "対象タスク。省略すると最新の実行中タスク" },
        title: { type: "string", description: "このステップで何をしたか/しているか。40文字以内目安" },
        kind: {
          type: "string",
          enum: KINDS,
          description:
            "plan=計画 think=考える search=検索 read=読む write=書く/編集 run=コマンド実行 web=ネットワーク/URL操作 check=確認/テスト fix=修正 wait=待機 note=メモ",
        },
        detail: { type: "string", description: "補足。コマンド、結果の要約、エラー内容など(秘密情報は書かない)" },
        status: { type: "string", enum: STEP_STATUS, description: "省略時は done。実行中は running" },
        now: { type: "string", description: "「いまやっていること」の表示文。省略時は title" },
        next: { type: "string", description: "「次にやること」の表示文" },
        progress: { type: "number", minimum: 0, maximum: 100, description: "全体の進捗(%)。分かる時だけ" },
        planIndex: { type: "integer", minimum: 1, description: "startTask の plan の何番目に当たるか(1始まり)" },
        agent: {
          ...AGENT_SCHEMA,
          description: "このステップを実行したAI。タスクの担当と別のAI(サブエージェントなど)のときだけ指定",
        },
      },
      required: ["title"],
    },
    annotations: { title: "ステップを記録する", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "updateStep",
    title: "ステップを更新する",
    description:
      "既存ステップの状態や内容を更新する。running にしたステップの完了(done)/失敗(failed)報告に使う。appendDetail で結果を追記できる。",
    inputSchema: {
      type: "object",
      properties: {
        stepId: { type: "integer", description: "addStep が返した stepId" },
        status: { type: "string", enum: STEP_STATUS },
        title: { type: "string", description: "タイトルを書き換える場合のみ" },
        detail: { type: "string", description: "detail を置き換える場合のみ" },
        appendDetail: { type: "string", description: "detail の末尾に追記(結果・出力の要約など)" },
        now: { type: "string" },
        next: { type: "string" },
        progress: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["stepId"],
    },
    annotations: { title: "ステップを更新する", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "setStatus",
    title: "いまの状況を更新する",
    description:
      "ステップを増やさずに「いまやっていること(now)」「次にやること(next)」「進捗」だけ更新する軽量な送信。長い処理の途中の生存報告にも使う。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "integer" },
        now: { type: "string", description: "いまやっていること" },
        next: { type: "string", description: "次にやること" },
        progress: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    annotations: { title: "いまの状況を更新する", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "finishTask",
    title: "作業を終了する",
    description:
      "作業を終える。成功(done)・失敗(failed)・中断(cancelled)のどれでも必ず呼ぶ。実行中のステップは自動で閉じられる。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "integer" },
        status: { type: "string", enum: TASK_END, description: "省略時は done" },
        summary: { type: "string", description: "結果の要約(1〜3文)" },
      },
    },
    annotations: { title: "作業を終了する", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "listTasks",
    title: "タスク一覧を見る",
    description: "最近のタスクと taskId を確認する。taskId を忘れた時や、前の作業を引き継ぐ時に使う。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30, description: "既定 10" },
        status: { type: "string", enum: ["running", ...TASK_END] },
      },
    },
    annotations: { title: "タスク一覧を見る", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/* ---------- 小さな道具 ---------- */

const clip = (v, n) => (v === undefined || v === null ? "" : String(v)).slice(0, n);
const pick = (a, ...keys) => {
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) return a[k];
  return undefined;
};
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const normProgress = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined;
};

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function presentedToken(request, url) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  return (m && m[1].trim()) || url.searchParams.get("token") || url.searchParams.get("key") || "";
}

// 書き込み(MCP): MCP_TOKEN が設定されていれば必須
function canWrite(request, url, env) {
  if (!env.MCP_TOKEN) return true;
  return safeEqual(presentedToken(request, url), env.MCP_TOKEN);
}

// 閲覧(ビューアー): VIEW_TOKEN が設定されていれば必須(MCP_TOKENでも可)
function canRead(request, url, env) {
  if (!env.VIEW_TOKEN) return true;
  const t = presentedToken(request, url);
  return safeEqual(t, env.VIEW_TOKEN) || (!!env.MCP_TOKEN && safeEqual(t, env.MCP_TOKEN));
}

function originOk(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // サーバー間通信(Museなど)はOriginを付けない
  try {
    if (new URL(origin).host === new URL(request.url).host) return true;
  } catch {
    return false;
  }
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

const board = (env) => env.BOARD.get(env.BOARD.idFromName("main"));

/* ---------- MCP (Streamable HTTP / JSON-RPC 2.0, ステートレス) ---------- */

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function rpc(msg, env) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcErr(null, -32600, "Invalid Request");
  const hasId = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method !== "string") return null; // クライアントからの応答は無視
  if (!hasId) return null; // 通知(notifications/initialized など)には返さない

  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return rpcOk(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "workline", title: "Workline", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, { tools: TOOLS });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const result = await board(env).callTool(tool.name, params.arguments || {});
        return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        return rpcOk(id, { content: [{ type: "text", text: String(e?.message || e) }], isError: true });
      }
    }
    default:
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(request, env, url) {
  const cors = {
    "access-control-allow-origin": request.headers.get("origin") || "*",
    "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!originOk(request, env)) return json(rpcErr(null, -32000, "Forbidden origin"), 403, cors);
  if (!canWrite(request, url, env)) {
    return json(rpcErr(null, -32001, "Unauthorized"), 401, { ...cors, "www-authenticate": 'Bearer realm="workline"' });
  }
  if (request.method !== "POST") {
    // SSEストリームもセッション終了も実装しない(ステートレス)
    return new Response("Method Not Allowed", { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcErr(null, -32700, "Parse error"), 400, cors);
  }

  if (Array.isArray(body)) {
    if (body.length === 0) return json(rpcErr(null, -32600, "Invalid Request"), 400, cors);
    const out = (await Promise.all(body.map((m) => rpc(m, env)))).filter(Boolean);
    return out.length ? json(out, 200, cors) : new Response(null, { status: 202, headers: cors });
  }
  const res = await rpc(body, env);
  return res ? json(res, 200, cors) : new Response(null, { status: 202, headers: cors });
}

/* ---------- ビューアー向け ---------- */

async function handleWs(request, env, url) {
  if (request.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
  if (!canRead(request, url, env)) return new Response("Unauthorized", { status: 401 });
  return board(env).fetch(request);
}

/* ---------- すべてのログを消す(人間だけが、何段階もの確認を通ったときだけ) ---------- */

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sign(env, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("workline-purge|" + (env.MCP_TOKEN || env.VIEW_TOKEN || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

// 簡易的な「人間確認」: 署名つきの足し算(10分で失効)。状態をサーバーに持たない
async function makeChallenge(env) {
  const a = 10 + Math.floor(Math.random() * 80);
  const b = 10 + Math.floor(Math.random() * 80);
  const body = `${a},${b},${Date.now() + 10 * 60000}`;
  return { question: `${a} + ${b}`, challenge: `${body}.${await sign(env, body)}` };
}

async function humanOk(env, challenge, answer) {
  const [body, sig] = String(challenge || "").split(".");
  if (!body || !sig || !safeEqual(sig, await sign(env, body))) return false;
  const [a, b, exp] = body.split(",").map(Number);
  return Date.now() < exp && Number(String(answer ?? "").trim()) === a + b;
}

// 閲覧用パスワード(VIEW_TOKEN)。VIEW_TOKEN が無い構成では、書き込みトークンでも通る
function passwordOk(env, pw) {
  const p = String(pw ?? "");
  if (!p) return false;
  return (!!env.VIEW_TOKEN && safeEqual(p, env.VIEW_TOKEN)) || (!!env.MCP_TOKEN && safeEqual(p, env.MCP_TOKEN));
}

async function handlePurge(request, env, url) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!canRead(request, url, env)) return json({ error: "unauthorized" }, 401);
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  // どちらのトークンも未設定だと、誰でも消せてしまうので、消去そのものを無効にする
  const enabled = !!(env.VIEW_TOKEN || env.MCP_TOKEN);
  const bd = board(env);

  switch (b.action) {
    case "info":
      return json({ enabled, ...(await bd.purgeInfo()) });
    case "challenge":
      return json(await makeChallenge(env));
    case "check-human":
      return json({ ok: await humanOk(env, b.challenge, b.answer) });
    case "check-password":
      if (!enabled) return json({ ok: false, error: "disabled" }, 403);
      if (passwordOk(env, b.password)) return json({ ok: true });
      await sleep(800); // 総当たりを遅くする
      return json({ ok: false });
    case "purge": {
      if (!enabled) return json({ ok: false, error: "disabled" }, 403);
      // 画面で通った順番どおり、サーバー側でも全部やり直して確かめる
      if (!(await humanOk(env, b.challenge, b.answer))) return json({ ok: false, step: "human" });
      if (!passwordOk(env, b.password)) {
        await sleep(800);
        return json({ ok: false, step: "password" });
      }
      if (b.word !== "delete") return json({ ok: false, step: "word" });
      return json(await bd.purgeAll(b.names));
    }
    default:
      return json({ error: "unknown action" }, 400);
  }
}

const ICON_TTL = 7 * 86400000; // 取得成功したアイコンは7日使い回す
const ICON_RETRY = 10 * 60000; // 取得に失敗したら10分は再取得しない

async function handleIcon(request, env, url) {
  if (!canRead(request, url, env)) return new Response("Unauthorized", { status: 401 });
  const b = board(env);
  const id = url.searchParams.get("agent") || "";
  const agent = await b.getAgent(id);
  const miss = () => new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=300" } });
  if (!agent || (!agent.domain && !agent.icon_url)) return miss();

  let cached = await b.getIcon(id);
  const stale = !cached || Date.now() - cached.at > (cached.type ? ICON_TTL : ICON_RETRY);
  if (stale) {
    const img = await findIcon(agent);
    cached = { type: img ? img.type : null, buf: img ? img.buf : null, at: Date.now() };
    await b.saveIcon(id, cached.type, cached.buf);
  }
  if (!cached.type || !cached.buf) return miss();
  return new Response(cached.buf, {
    headers: {
      "content-type": cached.type,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      // SVGが直接開かれてもスクリプトが動かないようにする(<img>経由なら元々動かない)
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

async function handleSnapshot(request, env, url) {
  if (!canRead(request, url, env)) return json({ error: "unauthorized" }, 401);
  return json(await board(env).snapshot());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/mcp") return await handleMcp(request, env, url);
      if (path === "/ws") return await handleWs(request, env, url);
      if (path === "/api/snapshot") return await handleSnapshot(request, env, url);
      if (path === "/api/icon") return await handleIcon(request, env, url);
      if (path === "/api/purge") return await handlePurge(request, env, url);
      if (path === "/api/health") return json({ ok: true, name: "workline", version: VERSION });
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------- Durable Object: 保存と配信 ---------- */

const taskRow = (r) => ({
  id: r.id,
  title: r.title,
  summary: r.summary,
  status: r.status,
  plan: JSON.parse(r.plan || "[]"),
  now: r.now_text,
  next: r.next_text,
  progress: r.progress,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
  result: r.result,
  agent: r.agent_id || "",
  model: r.model || "",
});

const agentRow = (r) => ({
  id: r.id,
  name: r.name,
  vendor: r.vendor,
  model: r.model,
  domain: r.domain,
  hasIcon: !!(r.domain || r.icon_url),
  lastSeen: r.last_seen,
});

const stepRow = (r) => ({
  id: r.id,
  taskId: r.task_id,
  kind: r.kind,
  title: r.title,
  detail: r.detail,
  status: r.status,
  planIdx: r.plan_idx,
  agent: r.agent_id || null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  endedAt: r.ended_at,
});

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      plan TEXT NOT NULL DEFAULT '[]',
      now_text TEXT NOT NULL DEFAULT '',
      next_text TEXT NOT NULL DEFAULT '',
      progress REAL,
      result TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      plan_idx INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS steps_task ON steps (task_id, id)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      icon_url TEXT NOT NULL DEFAULT '',
      icon_type TEXT,
      icon_blob BLOB,
      icon_at INTEGER,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`);
    // v1.0 からの更新用: 既に列があれば何もしない
    for (const ddl of [
      "ALTER TABLE tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE steps ADD COLUMN agent_id TEXT",
    ]) {
      try {
        this.sql.exec(ddl);
      } catch {}
    }
    // クライアントの "ping" に、DOを起こさず "pong" を返す(接続維持と死活確認)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /* --- WebSocket --- */

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.snapshot()));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (message === "snapshot") ws.send(JSON.stringify(this.snapshot()));
  }
  webSocketClose(ws) {
    try {
      ws.close(1000);
    } catch {}
  }
  webSocketError(ws) {
    try {
      ws.close(1011);
    } catch {}
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {}
    }
  }

  snapshot() {
    const tasks = this.sql
      .exec("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", SNAPSHOT_TASKS)
      .toArray()
      .map(taskRow);
    for (const t of tasks) {
      t.steps = this.sql
        .exec(
          "SELECT * FROM (SELECT * FROM steps WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
          t.id,
          SNAPSHOT_STEPS,
        )
        .toArray()
        .map(stepRow);
    }
    return {
      t: "snapshot",
      serverTime: Date.now(),
      auth: { writeOpen: !this.env.MCP_TOKEN, readOpen: !this.env.VIEW_TOKEN },
      agents: this.sql.exec("SELECT * FROM agents ORDER BY last_seen DESC LIMIT 50").toArray().map(agentRow),
      tasks,
    };
  }

  /* --- MCPツール --- */

  callTool(name, args) {
    const a = args && typeof args === "object" ? args : {};
    switch (name) {
      case "startTask":
        return this.startTask(a);
      case "addStep":
        return this.addStep(a);
      case "updateStep":
        return this.updateStep(a);
      case "setStatus":
        return this.setStatus(a);
      case "finishTask":
        return this.finishTask(a);
      case "listTasks":
        return this.listTasks(a);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  getTask(id) {
    const r = this.sql.exec("SELECT * FROM tasks WHERE id = ?", id).toArray()[0];
    return r ? taskRow(r) : null;
  }

  resolveTask(a) {
    const id = toInt(pick(a, "taskId", "task_id", "task"));
    const r =
      id !== null
        ? this.sql.exec("SELECT * FROM tasks WHERE id = ?", id).toArray()[0]
        : this.sql.exec("SELECT * FROM tasks WHERE status = 'running' ORDER BY id DESC LIMIT 1").toArray()[0];
    if (!r) {
      throw new Error(
        id !== null
          ? `taskId ${id} が見つかりません。listTasks で確認してください。`
          : "実行中のタスクがありません。先に startTask を呼んでください。",
      );
    }
    return taskRow(r);
  }

  mirrorPlan(taskId, idx, stepId, status) {
    const r = this.sql.exec("SELECT plan FROM tasks WHERE id = ?", taskId).toArray()[0];
    if (!r) return;
    const plan = JSON.parse(r.plan || "[]");
    const item = plan[idx - 1];
    if (!item) return;
    item.stepId = stepId;
    item.status = status;
    this.sql.exec("UPDATE tasks SET plan = ? WHERE id = ?", JSON.stringify(plan), taskId);
  }

  // now / next / progress が渡されたものだけ反映して updated_at を進める
  touchTask(taskId, a, fallbackNow) {
    const cur = this.sql.exec("SELECT now_text, next_text, progress FROM tasks WHERE id = ?", taskId).toArray()[0];
    const now = a.now !== undefined ? clip(a.now, LIMIT.line) : (fallbackNow ?? cur.now_text);
    const next = a.next !== undefined ? clip(a.next, LIMIT.line) : cur.next_text;
    const progress = normProgress(a.progress);
    this.sql.exec(
      "UPDATE tasks SET now_text = ?, next_text = ?, progress = ?, updated_at = ? WHERE id = ?",
      now,
      next,
      progress === undefined ? cur.progress : progress,
      Date.now(),
      taskId,
    );
  }

  // 申告されたAIを登録・更新する。ドメインやアイコンURLが変わったら、保存済みアイコンを捨てる
  upsertAgent(ag) {
    const now = Date.now();
    const prev = this.sql.exec("SELECT domain, icon_url FROM agents WHERE id = ?", ag.id).toArray()[0];
    this.sql.exec(
      `INSERT INTO agents (id, name, vendor, model, domain, icon_url, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         vendor = CASE WHEN excluded.vendor != '' THEN excluded.vendor ELSE vendor END,
         model = CASE WHEN excluded.model != '' THEN excluded.model ELSE model END,
         domain = CASE WHEN excluded.domain != '' THEN excluded.domain ELSE domain END,
         icon_url = CASE WHEN excluded.icon_url != '' THEN excluded.icon_url ELSE icon_url END,
         last_seen = excluded.last_seen`,
      ag.id,
      ag.name,
      ag.vendor,
      ag.model,
      ag.domain,
      ag.iconUrl,
      now,
      now,
    );
    if (prev && ((ag.domain && ag.domain !== prev.domain) || (ag.iconUrl && ag.iconUrl !== prev.icon_url))) {
      this.sql.exec("UPDATE agents SET icon_type = NULL, icon_blob = NULL, icon_at = NULL WHERE id = ?", ag.id);
    }
    return agentRow(this.sql.exec("SELECT * FROM agents WHERE id = ?", ag.id).one());
  }

  // アイコン取得用(Worker から RPC で呼ぶ)
  getAgent(id) {
    return this.sql.exec("SELECT id, domain, icon_url FROM agents WHERE id = ?", String(id)).toArray()[0] || null;
  }
  getIcon(id) {
    const r = this.sql.exec("SELECT icon_type, icon_blob, icon_at FROM agents WHERE id = ?", String(id)).toArray()[0];
    return r && r.icon_at ? { type: r.icon_type, buf: r.icon_blob, at: r.icon_at } : null;
  }
  saveIcon(id, type, buf) {
    this.sql.exec("UPDATE agents SET icon_type = ?, icon_blob = ?, icon_at = ? WHERE id = ?", type, buf, Date.now(), String(id));
  }

  startTask(a) {
    const ag = parseAgent(pick(a, "agent", "ai"));
    if (!ag) {
      throw new Error('agent は必須です。あなた自身(AI)を申告してください。例: { "name": "Muse", "model": "Muse Spark 1.3" }');
    }
    const title = clip(pick(a, "title", "name"), LIMIT.title).trim();
    if (!title) throw new Error("title は必須です。");
    const agent = this.upsertAgent(ag);
    const summary = clip(pick(a, "summary", "description", "goal"), LIMIT.summary);
    const plan = (Array.isArray(a.plan) ? a.plan : [])
      .slice(0, 30)
      .map((x) => ({ title: clip(typeof x === "string" ? x : x?.title, LIMIT.title).trim(), status: "planned", stepId: null }))
      .filter((x) => x.title);
    const now = Date.now();
    const row = this.sql
      .exec(
        `INSERT INTO tasks (title, summary, status, plan, now_text, next_text, started_at, updated_at, agent_id, model)
         VALUES (?, ?, 'running', ?, '', ?, ?, ?, ?, ?) RETURNING *`,
        title,
        summary,
        JSON.stringify(plan),
        plan[0]?.title ?? "",
        now,
        now,
        ag.id,
        ag.model,
      )
      .one();
    this.prune();
    this.broadcast({ t: "patch", task: taskRow(row), agent: agent });
    return {
      taskId: row.id,
      agent: ag.id,
      plan: plan.map((p, i) => ({ index: i + 1, title: p.title })),
      hint: "以降は addStep で小さな行動ごとに送ってください。plan がある場合は planIndex を渡すと予定が自動で更新されます。",
    };
  }

  addStep(a) {
    const task = this.resolveTask(a);
    const title = clip(pick(a, "title", "name"), LIMIT.title).trim();
    if (!title) throw new Error("title は必須です。");
    const count = this.sql.exec("SELECT COUNT(*) AS n FROM steps WHERE task_id = ?", task.id).one().n;
    if (count >= MAX_STEPS_PER_TASK) {
      throw new Error(`このタスクのステップ数が上限(${MAX_STEPS_PER_TASK})に達しました。finishTask して新しいタスクを始めてください。`);
    }
    const kind = KINDS.includes(a.kind) ? a.kind : "note";
    const status = STEP_STATUS.includes(a.status) ? a.status : "done";
    const planIdx = toInt(pick(a, "planIndex", "plan_index"));
    const ag = parseAgent(pick(a, "agent", "ai"));
    const agent = ag ? this.upsertAgent(ag) : null;
    const now = Date.now();
    const row = this.sql
      .exec(
        `INSERT INTO steps (task_id, kind, title, detail, status, plan_idx, agent_id, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        task.id,
        kind,
        title,
        clip(a.detail, LIMIT.detail),
        status,
        planIdx,
        ag && ag.id !== task.agent ? ag.id : null, // タスクの担当AIと同じなら記録しない
        now,
        now,
        status === "running" ? null : now,
      )
      .one();
    // next は毎回置き換える(古い「次」を残さない)
    this.touchTask(task.id, { ...a, next: a.next ?? "" }, title);
    if (planIdx) this.mirrorPlan(task.id, planIdx, row.id, status);
    this.broadcast({ t: "patch", task: this.getTask(task.id), steps: [stepRow(row)], ...(agent ? { agent } : {}) });
    return { stepId: row.id, taskId: task.id };
  }

  updateStep(a) {
    const id = toInt(pick(a, "stepId", "step_id", "id"));
    if (id === null) throw new Error("stepId は必須です。");
    const cur = this.sql.exec("SELECT * FROM steps WHERE id = ?", id).toArray()[0];
    if (!cur) throw new Error(`stepId ${id} が見つかりません。`);
    const now = Date.now();
    const title = a.title !== undefined ? clip(a.title, LIMIT.title).trim() || cur.title : cur.title;
    let detail = a.detail !== undefined ? clip(a.detail, LIMIT.detail) : cur.detail;
    const extra = pick(a, "appendDetail", "append_detail", "result");
    if (extra !== undefined) detail = clip((detail ? detail + "\n" : "") + String(extra), LIMIT.detail);
    const status = STEP_STATUS.includes(a.status) ? a.status : cur.status;
    const ended = status === "running" ? null : (cur.ended_at ?? now);
    const row = this.sql
      .exec(
        "UPDATE steps SET title = ?, detail = ?, status = ?, ended_at = ?, updated_at = ? WHERE id = ? RETURNING *",
        title,
        detail,
        status,
        ended,
        now,
        id,
      )
      .one();
    if (cur.plan_idx) this.mirrorPlan(cur.task_id, cur.plan_idx, id, status);
    this.touchTask(cur.task_id, a);
    this.broadcast({ t: "patch", task: this.getTask(cur.task_id), steps: [stepRow(row)] });
    return { ok: true, stepId: id, status };
  }

  setStatus(a) {
    const task = this.resolveTask(a);
    this.touchTask(task.id, a);
    this.broadcast({ t: "patch", task: this.getTask(task.id) });
    return { ok: true, taskId: task.id };
  }

  finishTask(a) {
    const task = this.resolveTask(a);
    const status = TASK_END.includes(a.status) ? a.status : "done";
    const stepEnd = status === "done" ? "done" : status === "failed" ? "failed" : "skipped";
    const now = Date.now();
    const closed = [];
    for (const r of this.sql.exec("SELECT * FROM steps WHERE task_id = ? AND status = 'running'", task.id).toArray()) {
      const row = this.sql
        .exec("UPDATE steps SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? RETURNING *", stepEnd, now, now, r.id)
        .one();
      if (r.plan_idx) this.mirrorPlan(task.id, r.plan_idx, r.id, stepEnd);
      closed.push(stepRow(row));
    }
    this.sql.exec(
      `UPDATE tasks SET status = ?, result = ?, now_text = '', next_text = '', progress = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      status,
      clip(pick(a, "summary", "result"), LIMIT.summary),
      status === "done" ? 100 : task.progress,
      now,
      now,
      task.id,
    );
    this.broadcast({ t: "patch", task: this.getTask(task.id), steps: closed });
    return { ok: true, taskId: task.id, status };
  }

  listTasks(a) {
    const limit = Math.max(1, Math.min(30, toInt(a.limit) ?? 10));
    const rows = TASK_END.concat("running").includes(a.status)
      ? this.sql.exec("SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ?", a.status, limit).toArray()
      : this.sql.exec("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", limit).toArray();
    return {
      tasks: rows.map((r) => ({
        taskId: r.id,
        title: r.title,
        agent: r.agent_id,
        status: r.status,
        steps: this.sql.exec("SELECT COUNT(*) AS n FROM steps WHERE task_id = ?", r.id).one().n,
        startedAt: new Date(r.started_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  }

  // 消去の前に見せる件数と、「いま残っているAI」の一覧
  purgeInfo() {
    const n = (t) => this.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n;
    return {
      tasks: n("tasks"),
      steps: n("steps"),
      agents: this.sql.exec("SELECT id, name FROM agents ORDER BY name").toArray(),
    };
  }

  // names は、画面でなぞったAIの id 一覧。いま残っているAIと完全に一致しなければ消さない
  purgeAll(names) {
    const now = this.sql.exec("SELECT id FROM agents").toArray().map((r) => r.id).sort();
    const given = [...new Set((Array.isArray(names) ? names : []).map(String))].sort();
    if (JSON.stringify(now) !== JSON.stringify(given)) return { ok: false, step: "names" };
    const info = this.purgeInfo();
    this.sql.exec("DELETE FROM steps");
    this.sql.exec("DELETE FROM tasks");
    this.sql.exec("DELETE FROM agents"); // 保存済みのアイコン画像も一緒に消える
    this.broadcast({ t: "purged" });
    return { ok: true, tasks: info.tasks, steps: info.steps, agents: info.agents.length };
  }

  prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const doomed = "SELECT id FROM tasks WHERE id NOT IN (SELECT id FROM tasks ORDER BY id DESC LIMIT ?) OR started_at < ?";
    this.sql.exec(`DELETE FROM steps WHERE task_id IN (${doomed})`, KEEP_TASKS, cutoff);
    this.sql.exec(`DELETE FROM tasks WHERE id IN (${doomed})`, KEEP_TASKS, cutoff);
  }
}
