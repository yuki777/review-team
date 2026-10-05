# GitHub PR への投稿

リードの判定を GitHub PR のレビューとして投稿する手順。利用者が投稿を明示的に依頼し、SKILL.md 4節の判定をすでに提示した場合だけ行う。対象は `--pr` で実行したレビューに限る。投稿は利用者のアカウントで公開されるので、承認なしに書き込みを始めない。以下で「本書の N 節」はこの文書の節を指す。

`$OUTPUT` は runner の出力先、`$PR_URL` は manifest の `repository.pr.url`、`$GH_HOST` は `$PR_URL` のホストを指す。GitHub への要求はすべて `gh api graphql --hostname "$GH_HOST" --input <要求ファイル>` で送る。

投稿は試行ごとに `$OUTPUT/github/<試行番号>/`（以下 `$ATTEMPT`、番号は 1 から）で行い、ファイルを上書きしない。

- `plan.json`、`summary.md`、`thread-<i>.md`: 利用者が承認した投稿内容。承認後は変えない。
- `<名前>.json` と `<名前>.out.json`: 送った要求と、受け取った応答。要求は送る前に書く。

```json
{ "pr": "https://github.com/o/r/pull/7", "commit": "<repository.commit>", "login": "<viewer.login>", "event": "COMMENT",
  "threads": [{ "finding": "claude:1", "path": "src/a.js", "line": 42, "side": "RIGHT", "startLine": 40, "startSide": "RIGHT" }] }
```

`threads` の i 番目（1 から数える）の本文は `thread-<i>.md`、総評は `summary.md` に置く。単一行の指摘では `startLine` と `startSide` を書かない。

応答は次のように読む。

- 期待した ID がある: 成功。
- `errors` がある: 失敗。GitHub には反映されていない。
- それ以外（応答ファイルが無い、空、壊れている）: 結果不明。届いたかどうか分からないので、同じ要求を送り直さない。

## 1. 投稿できる状態か確かめる

`$OUTPUT/github/` に試行があれば、最後の試行を読む。

- `create.out.json` にレビュー ID があれば、本書の4節の取得クエリでそのレビューを取る。提出済みなら本書の5節へ進む。`PENDING` なら、その試行の `plan.json` のまま本書の4節の続きから進める。取得結果が `null` なら下書きは削除済みなので、この試行は終わったものとして扱う。
- 結果不明の要求があれば止め、本書の4節「止めるとき」に従う。

`$OUTPUT/reviewed.diff` が無ければ投稿しない。これはレビュアーに渡した差分を runner が保存したもので、`--pr` の実行でしか作られない。

PR の現在の状態、投稿するアカウント、自分の pending review を取得する。

```graphql
query($url: URI!) {
  viewer { login }
  resource(url: $url) {
    ... on PullRequest {
      id state headRefOid viewerDidAuthor
      reviews(states: [PENDING], first: 5) { nodes { id } }
    }
  }
}
```

次のどれかに当たれば止めて、理由を利用者へ伝える。

- `state` が `OPEN` でない。
- `headRefOid` が manifest の `repository.commit` と違う。レビュー後に push があったので、再レビューを提案する。
- `gh pr diff "$PR_URL"` の出力が `$OUTPUT/reviewed.diff` とバイト単位で一致しない。base の付け替え、packet で渡した独自の差分、runner の取得中の push のどれでも、行位置がレビューした差分と対応しなくなる。シェルのフックが出力を加工する環境では、フックを通さない生の出力で比べる。
- 最後の試行のレビュー ID ではない pending review がある。GitHub は同じ利用者の pending review を PR ごとに一つしか持てない。手動の下書きかもしれないので、再利用・提出・削除をしない。

PR の `id`、`viewer.login`、`viewerDidAuthor` を控える。

完了条件: PR が open で、head と差分がレビューしたものと一致し、自分のものと確かめられない pending review が無い。

## 2. 投稿する指摘を選ぶ

投稿するのはリードの分類であり、子の重大度ではない。

| 分類 | 投稿先 |
| --- | --- |
| Act On（要対応） | インラインコメント。位置を差分上に置けなければ総評 |
| Consider（要検討） | 総評。特定の行について作者の回答が要るものだけインライン |
| Noted（参考） | 投稿しない |
| Dismissed（却下） | 投稿しない |

ブランチ保護で会話の解決を必須にしていると、未解決のインラインスレッドはマージを止める。そのため Consider は原則として総評に置く。件数を理由に指摘を黙って落とさない。量は本書の3節のプレビューで利用者が調整する。インラインは 100 件までにし、超えた分は総評に回す。

インラインの位置は `$OUTPUT/reviewed.diff` の hunk で決める。行番号を推測で補わない。

- hunk の見出し `@@ -a,b +c,d @@` で、`b` と `d` が省略されていれば 1 とみなす。
- 追加行と文脈行は、変更後の行番号 L（`c <= L < c+d`）と `side: RIGHT` を使う。
- 削除行は、変更前の行番号と `side: LEFT` を使う。
- 複数行は `startLine` と `startSide` を足す。範囲が一つの hunk に収まらなければ、最終行だけを指す。
- hunk の外を指す指摘（呼び出し元など未変更のファイルを含む）は総評に入れる。

インラインコメントの本文は次の形にする。出典 ID やモデル名は入れない。PR のタイトルと本文の言語に合わせる。

```markdown
🚨 **Act On(要対応)**

- **箇所**: `path:line`
- **問題**: 何が問題か
- **理由**: なぜ問題か。到達経路、短い引用、破られる条件
- **提案**: どう修正すべきか
```

**提案** に具体策が書けなければ、修正案をこしらえず、修正を決めるのに何が必要かを書く。

Consider をインラインにする場合は見出しを `⚠️ **Consider(要検討)**` にし、同じ4項目で書く。**問題** には未確定の点を、**理由** には作者に確かめたいことと、それで判断がどう変わるかを書く。重大な問題の可能性が文脈不足で Consider になっているなら、そのことを書き、軽い提案に見せない。

総評は次の形にする。

```markdown
### 総評
<全体の評価を1〜2文。Act On と Consider の件数と、最も重い問題>

- 対象コミット: <repository.commit の先頭 12 桁>
- テストは実行していません。未確認の範囲: <あれば>

### Act On(要対応)
差分の外にあり、インラインにできなかったもの。

**1. <指摘の見出し>**

- **箇所**: `path:line`
- **問題**: 何が問題か
- **理由**: なぜ問題か
- **提案**: どう修正すべきか

### Consider(要検討)
インラインの Consider と同じ4項目を、Act On と同じく番号付きの見出しの下に書く。

[review-team](https://github.com/yuki777/review-team)による自動レビューです。<レビュアー一覧> に同じ入力でレビューさせ、<リード> が指摘を検証しました。
```

承認するかどうかは総評に書かない。利用者が本書の3節で選んだ `event` で示す。

`<レビュアー一覧>` は manifest の `reviewers` から、全員を `<cli>:<requestedModel>:<requestedEffort>` の形で並べる。`status` が `ok` でないレビュアーには、`（失敗: <status>）` を後ろに付ける。これは要求した設定であり、CLI 報告モデルではない。

`<リード>` は、ホストが示す自分のモデル ID と effort を `<model>:<effort>` の形で書く。ホストが effort を示していなければ effort を省く。モデルも示されていなければ「リード」とだけ書く。自己紹介や推測で補わない。

例:

```markdown
[review-team](https://github.com/yuki777/review-team)による自動レビューです。`claude:claude-fable-5-1:high`、`codex:gpt-6-astra:high`、`grok:grok-4.7:high`（失敗: timeout）に同じ入力でレビューさせ、`claude-opus-5-5` が指摘を検証しました。
```

空の見出しは書かない。インラインの指摘は総評に重複させない。

完了条件: Act On と Consider の全件が、インライン・総評・利用者の判断で外したもののどれかに割り当てられている。

## 3. プレビューを見せて承認を得る

書き込みの前に、投稿するものを全部そのまま利用者に見せる。

- 投稿先の PR URL、対象コミット、投稿するアカウント（`viewer.login`）。
- `event`。既定は `COMMENT`。`REQUEST_CHANGES` と `APPROVE` は利用者が指定したときだけ使い、分類から自動で選ばない。`viewerDidAuthor` が `true` なら `COMMENT` だけを使う。利用者がほかの event を指定していたら、レビューを作る前にその理由を伝える。event を黙って変えない。
- 総評の全文。
- インラインコメントごとの `path`、行（範囲なら開始行も）、`side`、本文。
- 投稿しないことにした Act On と Consider の一覧。

利用者が外したり書き換えたりしたら、もう一度全体を見せる。承認されたら、新しい `$ATTEMPT` を作り、承認した内容をそのまま `plan.json`、`summary.md`、`thread-<i>.md` に書く。以後はこのファイルだけを投稿し、内容を変えるときは承認からやり直す。

完了条件: 利用者が承認した内容が、新しい `$ATTEMPT` に書かれている。

## 4. 投稿する

レビューを作る直前と提出する直前に、本書の1節の確認をもう一度行う。`viewer.login` が `plan.json` の `login` と違う場合も止める。

下の GraphQL は `$ATTEMPT/<名前>.graphql` に書き出して使う。要求は `plan.json` から `jq` で組み立て、本文をコマンドラインに展開しない。要求と応答は `create`、`thread-<i>`、`submit`、`delete` の名前で置く。

```sh
jq --rawfile query "$ATTEMPT/add-thread.graphql" --rawfile body "$ATTEMPT/thread-$i.md" \
  --arg review "$REVIEW_ID" --argjson i "$i" \
  '.threads[$i - 1] as $t | {query: $query, variables: ({review: $review, body: $body}
    + ($t | {path, line, side, startLine, startSide} | with_entries(select(.value != null))))}' \
  "$ATTEMPT/plan.json" > "$ATTEMPT/thread-$i.json"
gh api graphql --hostname "$GH_HOST" --input "$ATTEMPT/thread-$i.json" > "$ATTEMPT/thread-$i.out.json"
```

成功は終了コードだけで判断しない。応答を冒頭の規則で読み、成功でなければ次へ進まない。要求は一件ずつ順に送り、並列に送らない。

まず event を付けずに pending review を作る（`create`）。`commitOID` は `plan.json` の `commit` にする。返った `state` が `PENDING` であることを確かめる。

```graphql
mutation($pr: ID!, $commit: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit }) {
    pullRequestReview { id state }
  }
}
```

次に、`plan.json` の `threads` を順にインラインコメントとして追加する（`thread-<i>`）。

```graphql
mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $review, path: $path, line: $line, side: $side,
    startLine: $startLine, startSide: $startSide, subjectType: LINE, body: $body
  }) {
    thread { id comments(first: 1) { nodes { id } } }
  }
}
```

全件を追加したら、提出の前にレビューの中身を取得する。

```graphql
query($review: ID!) {
  node(id: $review) {
    ... on PullRequestReview {
      state body url
      comments(first: 100) { totalCount nodes { id path line url body } }
    }
  }
}
```

次のすべてが成り立たなければ提出しない。利用者がブラウザから同じ下書きを書き換えた可能性がある。

- `body` が空である。総評は提出時に渡すので、下書きの段階では空のはずである。
- `totalCount` が `plan.json` の `threads` の件数と等しい。
- コメントの `id` の集合が、各 `thread-<i>.out.json` のコメント ID の集合と等しい。
- 各コメントの `body` が、対応する `thread-<i>.md` と、末尾の改行を除いて同じである。

成り立てば、`summary.md` を総評、`plan.json` の `event` を event として提出する（`submit`）。

```graphql
mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) {
    pullRequestReview { id state url }
  }
}
```

止めるときは、提出せずに理由を利用者へ伝える。

- 自分の下書きが残っていれば、そのことと現在の中身を伝え、削除するかを利用者に選んでもらう。残すと、同じ PR への次の投稿は本書の1節で止まる。
- 削除に同意を得たら `deletePullRequestReview(input: { pullRequestReviewId: $review })` を送り（`delete`）、取得クエリの結果が `null` になったことを確かめる。やり直すときは本書の1節から始め、承認を経て新しい `$ATTEMPT` で投稿する。
- 提出の結果が不明なら、取得クエリで状態を確かめる。提出済みなら本書の5節へ進む。

完了条件: 提出の応答に `errors` が無く、`state` が `PENDING` 以外になっている。

## 5. 結果を確かめて報告する

本書の4節の取得クエリで提出したレビューを取り直し、承認した内容と照合する。

- `state` が event と対応している。`COMMENT` なら `COMMENTED`、`REQUEST_CHANGES` なら `CHANGES_REQUESTED`、`APPROVE` なら `APPROVED`。
- `body` が `summary.md` と、末尾の改行を除いて同じである。
- コメントの件数、`id`、`path`、`line`、`body` が、`plan.json` と各 `thread-<i>` のファイルと一致している。

利用者には、レビューの URL、`event`、インラインと総評の件数を伝える。各指摘の出典 ID と、その投稿先（コメントの URL または総評）の対応も伝える。投稿しなかった指摘と、その理由も伝える。

完了条件: 投稿されたレビューが GitHub 上で確認でき、承認した内容と一致し、利用者に対応が報告されている。
