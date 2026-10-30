# Muse AI 接続ガイド: Workline

Workline は、Muse が「いま何をしているか」を別画面でリアルタイムに眺めるためのビューアーです。
Muse は作業のたびに、この MCP サーバーへ小さく送信します。ブラウザには WebSocket で即時に届きます(定期取得ではありません)。

複数の AI に対応しています。送信するときに、AI 自身が「自分は何の AI か」を申告し、画面に名前とアイコンが出ます。
Muse 以外の AI(Claude、ChatGPT など)も、同じ URL・同じ依頼文で接続できます。

```
Muse ──(MCP / Streamable HTTP)──▶ Workline(Cloudflare) ──(WebSocket)──▶ あなたのブラウザ
```

## 1. 接続情報

| 項目 | 値 |
| --- | --- |
| MCP サーバー URL | `＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿/mcp` ← Cloudflare に公開したらここに入れる |
| トランスポート | Streamable HTTP(リモート)。POST のみ、セッションなし |
| 認証 | `Authorization: Bearer <MCP_TOKEN>`(Cloudflare 側で `MCP_TOKEN` を設定した場合のみ必須) |
| ビューアー | 上の URL から `/mcp` を除いたもの(ブラウザで開く) |

URL を入れたら、この表と、下の「3. Muse に渡す依頼文」の `URL:` の行を同じ値に書き換えてください。
ビューアーを開くと、空の画面に接続先 URL と、依頼文のコピーボタンが表示されます。

## 2. 事前準備(あなたがやること)

1. このリポジトリを Cloudflare Workers にデプロイする(`README.md` を参照)。
2. 書き込み用トークンを決めて、Worker のシークレット `MCP_TOKEN` に設定する。
   公開 URL を知っている人は誰でも送信できてしまうので、設定を強くおすすめします。
3. 自分だけが見るなら、閲覧用の `VIEW_TOKEN` も設定する(未設定だと URL を知っている人は誰でも閲覧できます)。
4. デプロイ後の URL を、上の表に書き込む。

## 3. Muse に渡す依頼文

Muse には「MCP サーバーを追加する」専用の設定画面がありません。
チャットで「このサーバーへのカスタム連携を作って」と頼むと、Muse が自分で連携を作ります。
次の文章をそのまま Muse に送ってください(`URL:` の行は上で決めた値に置き換えます)。
ビューアーの空の画面にある「AIへの依頼文をコピー」でも、同じ文章を取り出せます。

```
次の MCP サーバー(Streamable HTTP)に接続するカスタム連携を作ってください。

URL: ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿/mcp
認証: Authorization: Bearer <トークン> ヘッダーを付けます。
      トークンは、私が入力するボタンから安全な認証情報ストアに保存してください。
      チャットや作業ログにトークンを書かないでください。

接続できたら、tools/list で使えるツールを確認し、
このあとの作業はすべて、次のルールで送信しながら進めてください。
```

Muse 以外の AI に接続するときは、同じ文章の中の「Muse」を、その AI の名前に読み替えてください(次の節の `agent` に入れる名前も同じです)。

トークンを設定していない場合は「認証」の 3 行を消してください。

## 4. 自分が何の AI かを申告する(agent)

`startTask` を呼ぶときに、AI 自身が `agent` を必ず渡します。省略するとエラーになります。

```json
{ "name": "Muse", "model": "Muse Spark 1.3", "domain": "muse.ai" }
```

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `name` | はい | AI の名前。同じ名前なら同じ AI として扱われ、画面でまとめて絞り込めます |
| `model` | いいえ | モデル名。タスクごとに記録され、画面のタスク名の横に出ます |
| `domain` | いいえ | 公式サイトのドメイン。アイコンの取得に使います |
| `iconUrl` | いいえ | アイコン画像の `https` URL。あれば最優先で使います |

名前だけ渡して、`"agent": "Muse"` のように文字列で送ることもできます。

### アイコンの取得

サーバーが、申告された `domain`(または `iconUrl`)から画像を取得して保存し、画面に表示します。次の順に試します。

1. `iconUrl`
2. サイトのトップページに書かれたアイコン(`apple-touch-icon`、`icon`)
3. `https://<domain>/favicon.ico`
4. favicon 取得サービス(Google)

- 名前が `Muse` `Claude` `ChatGPT` `Gemini` などの有名な AI なら、`domain` を省略しても自動で補います。`Muse` は `muse.ai` です。
- 取得できたアイコンは 7 日間、サーバーに保存します。失敗したときは 10 分あけて再取得し、その間は名前の頭文字を色つきで表示します。
- 取得先は、公開された `https` のドメインだけです。IP アドレスや `localhost` などは拒否します。

### 複数の AI が同時に動くとき

- AI ごとに別々の `startTask` を呼びます。画面の左に、AI ごとの絞り込みボタンと、実行中のタスク数が出ます。
- 同じタスクの中で別の AI(サブエージェントなど)が作業したときは、そのステップの `addStep` に `agent` を付けます。画面では、そのステップに AI の名前とアイコンが付きます。

```json
{ "title": "境界値テストを作成", "kind": "write", "status": "running",
  "agent": { "name": "Reviewer Bot", "domain": "example.dev" } }
```

## 5. Muse に守らせる作業ルール

接続できたら、次の文章も Muse に送ります。
「記憶しておいて」と添えると、次回以降も続きます。

```
今後、作業するときは Workline に送信してください。

- 作業を始めたら、最初に startTask を呼ぶ。手順の見通しがあれば plan に入れる。
  agent には自分自身を入れる(例: { "name": "Muse", "model": "<あなたのモデル名>", "domain": "muse.ai" })。
- 小さな行動ひとつごとに addStep を呼ぶ(ファイルを読む、検索する、コマンドを実行する、
  編集する、確認する、方針を考える、待つ)。あとでまとめて送らない。
- 時間がかかる行動は、始める時に status="running" で送り、終わったら updateStep で
  "done" か "failed" にする。すぐ終わる行動は status を省略して 1 回で送る。
- 30 秒以上黙りそうな時は、その前に setStatus で「いまやっていること」と「次」を更新する。
- 作業が終わったら(失敗・中断も)必ず finishTask を呼ぶ。
- title は人間が読む短い日本語(40 文字以内)。コマンドや結果の要約は detail に入れる。
- パスワード・トークン・API キーは title にも detail にも書かない。
```

## 6. ツール一覧

引数は `taskId` を省略すると「最新の実行中タスク」が対象になります。`stepId` と `taskId` は戻り値で返ります。
忘れたときは `listTasks` で確認できます。

| ツール | 使うタイミング | 主な引数 |
| --- | --- | --- |
| `startTask` | 作業の最初に 1 回 | `agent`(必須), `title`(必須), `summary`, `plan`(文字列の配列) |
| `addStep` | 小さな行動のたび | `title`(必須), `kind`, `detail`, `status`, `now`, `next`, `progress`, `planIndex`, `agent`(別の AI のときだけ) |
| `updateStep` | running のステップを完了・失敗にする / 結果を追記する | `stepId`(必須), `status`, `appendDetail`, `detail`, `title` |
| `setStatus` | ステップを増やさず「いま」と「次」だけ更新する(生存報告) | `now`, `next`, `progress` |
| `finishTask` | 作業の最後に必ず 1 回 | `status`(`done` / `failed` / `cancelled`), `summary` |
| `listTasks` | taskId を忘れたとき | `limit`, `status` |

### kind(ステップの種類)

| kind | 表示 | 使いどころ |
| --- | --- | --- |
| `plan` | 計画 | 手順を決めた |
| `think` | 考え中 | 原因の推測、方針の切り替え |
| `search` | 検索 | Web や資料の検索 |
| `read` | 読み込み | ファイル・ページを読む |
| `write` | 編集 | ファイルを作る・書き換える |
| `run` | 実行 | コマンド実行(detail は等幅で表示されます) |
| `web` | 通信 | URL へのアクセス、トンネル、API 呼び出し |
| `check` | 確認 | テスト、疎通確認、結果の検証 |
| `fix` | 修正 | 不具合の修正 |
| `wait` | 待機 | 完了待ち、スリープ |
| `note` | メモ | 上のどれでもないもの(省略時の既定) |

### status(ステップの状態)

`running`(実行中。経過時間が動く) / `done`(既定) / `failed`(赤で表示) / `skipped`。

### plan と planIndex

`startTask` の `plan` に 4 項目を渡すと、画面に予定のチェックリストが出ます。
`addStep` に `planIndex: 2` を渡すと、2 番目の予定がそのステップの状態(実行中・完了・失敗)に連動します。

## 7. 送信の流れ(例)

```
startTask   { agent: { name: "Muse", model: "Muse Spark 1.3", domain: "muse.ai" },
              title: "noVNCをChromeで試す", plan: ["cloudflaredを用意", "トンネルを開く", "URLを確認", "閉じる"] }
            → { taskId: 12, agent: "muse", plan: [...] }
addStep     { title: "cloudflaredを取得中", kind: "run", status: "running", planIndex: 1,
              detail: "curl -L -o cloudflared ...", next: "トンネルを開く" }
            → { stepId: 31 }
updateStep  { stepId: 31, status: "done", appendDetail: "41MB 取得、実行権限を付与" }
addStep     { title: "6080番へトンネルを開く", kind: "web", planIndex: 2, next: "URLの疎通を確認" }
addStep     { title: "URLにアクセスして確認", kind: "check", status: "failed", planIndex: 3,
              detail: "HTTP 530。トンネルがまだ立ち上がっていない可能性" }
addStep     { title: "原因を考える", kind: "think" }
setStatus   { now: "登録完了まで待機", next: "新しいURLで確認", progress: 55 }
finishTask  { status: "done", summary: "新しいURLで開けることを確認。トンネルは閉じた。" }
```

画面の「いまやっていること」は、`addStep` の `now`(省略時は `title`)と `next` で更新されます。
`next` は毎回置き換わるので、古い「次」が残ることはありません。

## 8. 動作確認

### ビューアーで

ビューアーを開いたまま、Muse に「Workline に `startTask` で『接続テスト』を送って(agent に自分を申告して)、`addStep` を 3 回送って、`finishTask` して」と頼みます。
右上が「ライブ」で、ステップが 1 件ずつ増え、タスク名の横に Muse の名前とアイコンが出れば成功です。

### Muse の連携がうまく作れないとき(curl で直接確認)

Muse は自分の環境でコマンドを実行できるので、次の 2 行を実行してもらうと、サーバー側の問題か連携側の問題かを切り分けられます。

```bash
# 1) 使えるツールが 6 つ返れば OK
curl -s -X POST "<URL>/mcp" \
  -H "content-type: application/json" -H "authorization: Bearer <トークン>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2) 画面に「curlテスト」が Muse の名前つきで出れば OK
curl -s -X POST "<URL>/mcp" \
  -H "content-type: application/json" -H "authorization: Bearer <トークン>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"startTask","arguments":{"agent":{"name":"Muse","domain":"muse.ai"},"title":"curlテスト"}}}'
```

`<URL>` は `https://…` から `/mcp` の手前まで、`<トークン>` は `MCP_TOKEN` の値です。
トークン未設定なら `authorization` のヘッダーは不要です。

## 9. うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| `401 Unauthorized` | トークンが違う、またはヘッダーが付いていない。`Authorization: Bearer <MCP_TOKEN>` を確認する(ヘッダーを付けられない環境では URL の末尾に `?token=<MCP_TOKEN>` でも通ります) |
| `403 Forbidden origin` | ブラウザから直接送っている。Muse など実行環境からの送信なら出ません |
| ツールが `実行中のタスクがありません` と返す | `startTask` より先に `addStep` を呼んだ。先に `startTask` を呼ぶ |
| `agent は必須です` と返る | `startTask` に `agent` が無い。`{ "name": "Muse" }` のように自分を申告する |
| アイコンが出ず、頭文字だけ表示される | 取得できていない。`domain` が正しいか、`iconUrl` が `https` の画像か確認する。直したあとは、同じ名前で新しく `startTask` すると取り直します |
| 画面が「再接続中」のまま | ネットワークの一時切断。自動で再接続し、その間も 5 秒ごとに最新状態を取りにいきます |
| 画面に「最終更新から ○○ 経過」の警告が出た | 90 秒以上、何も送られていません。Muse が長い処理中か、送信が止まっています |
| 古いタスクが消えた | 新しい方から 100 件、30 日以内のものだけ保存されます |

## 10. セキュリティの注意

- Muse に、パスワード・トークン・API キーを `title` / `detail` に書かせないでください(ルールに入れてあります)。
- `MCP_TOKEN` は書き込み、`VIEW_TOKEN` は閲覧のためのものです。別の値にしてください。
- トークンを変えたいときは、Cloudflare のシークレットを更新し、Muse の認証情報ストアも更新します。
- ログの全消去は、人間が画面から行う操作だけです。Muse など AI のツールには、消去する機能はありません。
- `agent` は自己申告です。トークンを持っている送信元が、別の AI の名前を名乗ることもできます。AI ごとにトークンを分けたい場合は、別の Worker を立ててください。
- アイコンの取得は、サーバーから外部サイトへアクセスします。取得先は公開 `https` のドメインに限り、画像以外の内容は保存しません。
