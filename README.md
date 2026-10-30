# Workline

AI(Muse など)の作業を、MCP で受け取ってリアルタイムに表示するビューアーです。

- 送信: MCP(Streamable HTTP)。AI がタスクごと・ステップごとに細かく送る
- 複数の AI に対応: 送信時に AI 自身が名前・モデルを申告し(`agent`)、サーバーが公式サイトのアイコンを取得して表示する
- 配信: WebSocket(Durable Object)。切れている間は 5 秒ごとの取得に切り替わる
- 構成: `src/worker.js`(MCP サーバーと配信)+ `src/agents.js`(AI の申告とアイコン取得)+ `public/index.html`(ビューアー 1 枚)
- 保存: Durable Object の SQLite(新しい 100 件、30 日まで)

Muse への接続方法は [MUSE_GUIDE.md](./MUSE_GUIDE.md) にあります。

## デプロイ(GitHub から)

1. このフォルダを GitHub のリポジトリにする(例: `zixiang0623/Workline`)。
2. Cloudflare の Workers & Pages で「Import a repository」からそのリポジトリを選ぶ。
   ビルドコマンドは空のまま、デプロイコマンドは `npx wrangler deploy`。
3. 設定の「Variables and Secrets」に、シークレットを 2 つ追加する。

   | 名前 | 役割 | 未設定のとき |
   | --- | --- | --- |
   | `MCP_TOKEN` | 書き込み(MCP)に必要 | URL を知っている人は誰でも送信できる |
   | `VIEW_TOKEN` | ビューアーの閲覧に必要 | URL を知っている人は誰でも閲覧できる |

4. 発行された `https://workline.<あなたのサブドメイン>.workers.dev` を開く。
   MCP の URL はそれに `/mcp` を付けたものです(ビューアーの空画面にも表示されます)。

v1.0 から更新する場合も、保存済みのデータはそのまま使えます(列は起動時に自動で追加されます)。ただし `startTask` に `agent` が必須になったので、AI 側の依頼文を差し替えてください。

初回デプロイで Durable Object のマイグレーション(`wrangler.jsonc` の `migrations`)が自動で適用されます。

## ローカルで動かす

```bash
npm install
printf 'MCP_TOKEN=test\nVIEW_TOKEN=test\n' > .dev.vars   # 省略可
npx wrangler dev
```

`http://localhost:8787` を開き、別のターミナルから送信して確かめます。

```bash
curl -s -X POST http://localhost:8787/mcp \
  -H "content-type: application/json" -H "authorization: Bearer test" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"startTask","arguments":{"title":"テスト"}}}'
```

## エンドポイント

| パス | 内容 |
| --- | --- |
| `/` | ビューアー |
| `/mcp` | MCP サーバー(POST のみ) |
| `/ws` | ビューアー向け WebSocket |
| `/api/snapshot` | 現在の状態(JSON) |
| `/api/icon?agent=<id>` | 申告された AI のアイコン画像(初回に取得して保存) |
| `/api/health` | 死活確認 |

## ビューアーの機能

- 実行中の「いまやっていること」と「次」を上部に固定表示。進捗バーと、予定チェックリストに連動(広い画面では予定を右の列に固定)
- 実行中のステップは色つきの帯で強調、失敗は赤の帯。新しいステップは届いた瞬間にふわっと光る
- 上部に「N件実行中」(全AI合計)。90秒以上更新がないタスクは、一覧のアイコンが警告色になる
- 時刻つきのステップ一覧(新しい順 / 古い順の切り替え、前のステップからの経過、実行中ステップの経過時間)
- 90 秒以上更新がないと警告
- 失敗したステップは赤で表示、URL は自動でリンクに
- AI ごとの名前とアイコン(取得できないときは頭文字)。2 つ以上の AI が送信すると、左に絞り込みと実行中のタスク数が出る
- 別の AI(サブエージェントなど)が行ったステップには、その AI の名前とアイコンが付く
- タスク一覧、「最新を追う」、ログのコピー(Markdown)、通知音(初期はオフ)
- 幅 60rem 未満ではタスク一覧がドロワーになり、スワイプで閉じられる
