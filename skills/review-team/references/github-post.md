# GitHub PR への投稿

リードの判定を GitHub PR のレビューとして投稿する手順。利用者が投稿を明示的に依頼し、4節の判定をすでに提示した場合だけ行う。対象は `--pr` で実行したレビューに限る。投稿は利用者のアカウントで公開されるので、承認なしに書き込みを始めない。

`$OUTPUT` は runner の出力先、`$PR_URL` は manifest の `repository.pr.url`、`$GH_HOST` は `$PR_URL` のホストを指す。GitHub への要求はすべて `gh api graphql --hostname "$GH_HOST" --input <要求ファイル>` で送る。要求と応答のファイルは `$OUTPUT/github/` に置き、上書きしない。

投稿の記録は `$OUTPUT/github/review.json` に残す。レビュー ID が返ったらすぐ書き、スレッドを追加するたび、提出したときにも書き足す。

```json
{ "reviewId": "PRR_...", "threads": [{ "finding": "claude:1", "threadId": "PRRT_...", "commentId": "PRRC_...", "path": "src/a.js", "line": 42, "side": "RIGHT" }], "submitted": false }
```

## 1. 投稿できる状態か確かめる

`$OUTPUT/github/review.json` がすでにあれば、前回の投稿の続きである。新しいレビューを作らず、その `reviewId` の状態を取得して、提出済みなら5節へ、未提出なら4節の続きへ進む。

`manifest.json` の `repository.commit` を、レビューしたコミットとして読む。`repository.pr` が無ければ `--pr` の実行ではないので投稿しない。packet に独自の `diff` を入れて実行した場合は、その差分が `repository.commit` の PR 差分と同じだと確かめられない限り投稿しない。

PR の現在の状態、投稿するアカウント、自分の pending review を取得する。

```graphql
query($url: URI!) {
  viewer { login }
  resource(url: $url) {
    ... on PullRequest {
      id state headRefOid viewerDidAuthor
      reviews(states: [PENDING], first: 5) { nodes { id createdAt comments { totalCount } } }
    }
  }
}
```

次のどれかに当たれば止めて、理由を利用者へ伝える。

- `state` が `OPEN` でない。
- `headRefOid` が `repository.commit` と違う。レビュー後に push があり、行位置も指摘の成立も確かめ直す必要がある。再レビューを提案する。
- `review.json` の `reviewId` ではない pending review がある。GitHub は同じ利用者の pending review を PR ごとに一つしか持てない。手動の下書きかもしれないので、再利用・提出・削除をしない。

PR の `id`、`viewer.login`、`viewerDidAuthor` を控える。

完了条件: PR が open で、head がレビューしたコミットと一致し、自分のものと確かめられない pending review が無い。

## 2. 投稿する指摘を選ぶ

投稿するのはリードの分類であり、子の重大度ではない。

| 分類 | 投稿先 |
| --- | --- |
| Act On（要対応） | インラインコメント。位置を差分上に置けなければ総評 |
| Consider（要検討） | 総評。特定の行について作者の回答が要るものだけインライン |
| Noted（参考） | 投稿しない |
| Dismissed（却下） | 投稿しない |

ブランチ保護で会話の解決を必須にしていると、未解決のインラインスレッドはマージを止める。そのため Consider は原則として総評に置く。件数を理由に指摘を黙って落とさない。量は3節のプレビューで利用者が調整する。

インラインの位置は `gh pr diff "$PR_URL"` の hunk で決める。行番号を推測で補わない。

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

- **箇所**: `path:line`
- **問題**: 何が問題か
- **理由**: なぜ問題か
- **提案**: どう修正すべきか

### Consider(要検討)
インラインの Consider と同じ形で書く。

[review-team](https://github.com/yuki777/review-team)による自動レビューです。<レビュアー一覧> に同じ入力でレビューさせ、<リード> が指摘を検証しました。
```

承認するかどうかは総評に書かない。利用者が3節で選んだ `event` で示す。

`<レビュアー一覧>` は manifest の `reviewers` から、全員を `<cli>:<requestedModel>:<requestedEffort>` の形で並べる。`requestedEffort` が無ければ `:<requestedEffort>` を省く。`status` が `ok` でないレビュアーには、`（失敗: <status>）` を後ろに付ける。これは要求した設定であり、CLI 報告モデルではない。

`<リード>` は、ホストが示す自分のモデル ID と effort を `<model>:<effort>` の形で書く。ホストが effort を示していなければ effort を省く。モデルも示されていなければ「リード」とだけ書く。自己紹介や推測で補わない。

例:

```markdown
[review-team](https://github.com/yuki777/review-team) による自動レビューです。`claude:claude-fable-5-1:high`、`codex:gpt-6-astra:high`、`grok:grok-4.7:high`（失敗: timeout）に同じ入力でレビューさせ、`claude-opus-5-5` が指摘を検証しました。
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

利用者が外したり書き換えたりしたら、もう一度全体を見せる。承認された内容だけを投稿する。

完了条件: 利用者が、この一覧のとおりに投稿することを承認している。

## 4. 投稿する

レビューを作る直前と提出する直前に、1節のクエリをもう一度実行する。PR が open でない、head が変わった、`viewer.login` が承認時と違う、のどれかなら、そこで止めて報告する。

要求はファイルに書いて送る。本文をコマンドラインに展開しない。`jq` で組み立てると、本文の改行や引用符を壊さない。

```sh
jq -n --rawfile query "$OUTPUT/github/add-thread.graphql" --rawfile body "$OUTPUT/github/thread-1.md" \
  --arg review "$REVIEW_ID" --arg path "$FILE_PATH" --argjson line "$LINE" --arg side "$SIDE" \
  '{query: $query, variables: {review: $review, path: $path, line: $line, side: $side, body: $body}}' \
  > "$OUTPUT/github/thread-1.json"
gh api graphql --hostname "$GH_HOST" --input "$OUTPUT/github/thread-1.json" > "$OUTPUT/github/thread-1.out.json"
```

`$SIDE` などの値は、承認したプレビューのものを使う。複数行なら `variables` に `startLine` と `startSide` を足す。

成功は終了コードだけで判断しない。応答に `errors` が無く、期待した ID が返っていることを毎回確かめ、`review.json` に書き足す。コメントは一件ずつ順に追加し、並列に送らない。

まず event を付けずに pending review を作る。`commitOID` は `repository.commit` にする。返った `id` をすぐ `review.json` に書き、`state` が `PENDING` であることを確かめる。

```graphql
mutation($pr: ID!, $commit: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit }) {
    pullRequestReview { id state }
  }
}
```

次に、インラインコメントを一件ずつ追加する。

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

全件を追加したら、提出の前にレビューの中身を取得する。次のすべてが成り立たなければ提出しない。利用者がブラウザから同じ下書きにコメントを足したり、書き換えたりした可能性がある。

- `totalCount` が `review.json` の `threads` の件数と等しい。
- 取得したコメントの `id` の集合が、`threads` の `commentId` の集合と等しい。
- 各コメントの `body` が、承認した本文（`thread-<n>.md`）と、末尾の改行を除いて同じである。

一度に取得するのは 100 件までなので、インラインコメントが 100 件を超える投稿はこの手順で扱わない。プレビューの段階で分けるよう利用者に伝える。

```graphql
query($review: ID!) {
  node(id: $review) {
    ... on PullRequestReview { state url comments(first: 100) { totalCount nodes { id path line url body } } }
  }
}
```

一致したら提出し、`review.json` の `submitted` を `true` にする。

```graphql
mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) {
    pullRequestReview { id state url }
  }
}
```

失敗したときは次のように扱う。

- **`errors` が返った**: その時点で止め、提出しない。どの指摘で何が返ったかを利用者に伝える。作り直す場合は、`review.json` の `reviewId` の下書きだけを `deletePullRequestReview(input: { pullRequestReviewId: $review })` で消してから、1節からやり直す。消す前に、その下書きの現在の中身を利用者に見せて同意を得る。
- **結果が分からない**（タイムアウト、通信断）: 同じ要求を再送しない。レビュー作成の応答が失われて `reviewId` が無いなら、見つかった pending review を自分のものとみなさず、止めて利用者に伝える。`reviewId` があれば、そのレビューの中身を取得して `review.json` と照合し、届いたと確かめられたものは記録して、残りだけを送る。

完了条件: 提出の応答に `errors` が無く、`review.json` の `submitted` が `true` になっている。

## 5. 結果を確かめて報告する

提出したレビューを取り直し、承認したプレビューと照合する。

- `state` が event と対応している。`COMMENT` なら `COMMENTED`、`REQUEST_CHANGES` なら `CHANGES_REQUESTED`、`APPROVE` なら `APPROVED`。
- インラインコメントの件数と `path`・`line` が、`review.json` の `threads` と一致している。

利用者には、レビューの URL、`event`、インラインと総評の件数を伝える。各指摘の出典 ID と、その投稿先（コメントの URL または総評）の対応も伝える。投稿しなかった指摘と、その理由も伝える。

完了条件: 投稿されたレビューが GitHub 上で確認でき、承認したプレビューと一致し、利用者に対応が報告されている。
