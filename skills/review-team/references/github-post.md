# GitHub PR への投稿

リードの判定を GitHub PR のレビューとして投稿する手順。利用者が投稿を明示的に依頼し（起動時の `--comment` を含む）、SKILL.md 4節の判定をすでに提示した場合だけ行う。対象は `--pr` で実行したレビューに限る。投稿は利用者のアカウントで公開されるので、承認なしに書き込みを始めない。起動時の `--comment` を承認とみなすのは、本書の3節で定める範囲だけである。以下で「本書の N 節」はこの文書の節を指す。

`$OUTPUT` は runner の出力先、`$PR_URL` は manifest の `repository.pr.url`、`$GH_HOST` は `$PR_URL` のホストを指す。GitHub への要求はすべて `gh api graphql --hostname "$GH_HOST" --input <要求ファイル>` で送る。

投稿は試行ごとに `$OUTPUT/github/<試行番号>/`（以下 `$ATTEMPT`、番号は 1 から）で行い、ファイルを上書きしない。

- `plan.json`、`summary.md`、`thread-<i>.md`、`previous-<j>.md`: 利用者が承認した投稿内容。承認後は変えない。
- `<名前>.json` と `<名前>.out.json`: 送った要求と、受け取った応答。要求は送る前に書く。

```json
{ "pr": "https://github.com/o/r/pull/7", "commit": "<repository.commit>", "login": "<viewer.login>",
  "threads": [{ "finding": "claude:1", "path": "src/a.js", "line": 42, "side": "RIGHT", "text": "  return cache.get(key);",
    "startLine": 40, "startSide": "RIGHT" }],
  "previous": [{ "thread": "<スレッドの ID>", "url": "<最初のコメントの URL>", "action": "resolve",
    "lastComment": "<取得したときの最後のコメントの ID>" }] }
```

`threads` の i 番目（1 から数える）の本文は `thread-<i>.md`、`previous` の j 番目の返信の本文は `previous-<j>.md`、総評は `summary.md` に置く。`previous` は本書の2節「前回のスレッド」で決め、無ければ空の配列にする。`text` は `line` の行の内容で、本書の2節の一覧から写す。単一行の指摘では `startLine` と `startSide` を書かない。

更新要求（mutation）の応答は次のように読む。

- 期待した ID がある: 成功。
- 要求ファイルがあって、それ以外（`errors` がある、応答ファイルが無い、空、壊れている）: 結果不明。`errors` があっても反映されていないとは限らないので、同じ試行で同じ要求を送り直さない。

要求ファイルが無いものは、まだ送っていないだけである。

取得クエリの応答はデータとして読む。存在しない ID を取ると `node: null` と `NOT_FOUND` の `errors` が同時に返るので、これは「対象が存在しない」と読む。

試行は次のどれかで終わり、終わった試行は再開しない。

- 提出した。取得した `state` が `PENDING` 以外である。
- 下書きを削除した。取得結果が `NOT_FOUND` である。
- `create` が届かなかった。`create` が結果不明で、本書の1b のクエリで自分の pending review が0件である。
- 捨てた。`create` をまだ送っていない試行は、再開せずに捨てる。

やり直しは本書の1節から、新しい `$ATTEMPT` で行う。承認した内容を変えないなら、前の試行の `plan.json`、`summary.md`、`thread-<i>.md`、`previous-<j>.md` を写してよい。結果不明の `create` や `thread-<i>` がある試行を、同じ下書きのまま続けない。`submit` が結果不明のときは、本書の4節「止めるとき」に従う。

## 1. 投稿できる状態か確かめる

1a で前の試行を片付けてから、1b で PR の状態を確かめる。本書の4節から確かめ直すときは 1b だけを行う。

### 1a. 前の試行を片付ける

`$OUTPUT/github/` に試行があれば、最後の試行が終わっているかを先に確かめる。まず本書の1b のクエリで `viewer.login` が `plan.json` の `login` と同じことを確かめ、違えば止める。pending review は作成者にしか見えないので、別のアカウントでは判定を誤る。

- `create` をまだ送っていなければ、その試行を捨てる。投稿するなら、その試行のファイルを案として本書の3節のプレビューからやり直す。承認を経ずに書き込みへ進まない。起動時の `--comment` も、ここでは承認とみなさない。
- `create` が成功していれば、本書の4節の取得クエリでそのレビューを取る。提出済みなら本書の5節へ進む。`NOT_FOUND` なら試行は終わっている。`PENDING` で、結果不明の要求が無く、成功したスレッドの応答がすべて `plan.json` の位置と一致していれば、本書の1b を行ってから本書の4節の続きを進める。続きでは、期待した ID がある `create` と `thread-<i>` を送らず、要求ファイルの無い最初の番号から送る。送る thread が残っていなければ、本書の4節の「全件を追加したら」から進む。それ以外の `PENDING` は、本書の4節「止めるとき」に従う。
- `create` が結果不明なら、自分の pending review を確かめる。0件なら試行は終わっている。あれば、この試行で作られたものか断定できないので、中身を利用者に見せて止める。利用者がこの試行のものとして削除に同意したら、その ID で削除し、`NOT_FOUND` を確かめて試行を終える。

### 1b. PR の状態を確かめる

`$OUTPUT/reviewed.diff` が無ければ投稿しない。これはレビュアーに渡した差分を runner が保存したもので、`--pr` の実行でしか作られない。

PR の現在の状態、投稿するアカウント、自分の pending review を取得する。

```graphql
query($url: URI!) {
  viewer { login }
  resource(url: $url) {
    ... on PullRequest {
      id state headRefOid
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

PR の `id` と `viewer.login` を控える。

完了条件: PR が open で、head と差分がレビューしたものと一致し、自分のものと確かめられない pending review が無い。

## 2. 投稿する指摘を選ぶ

投稿するのはリードの分類であり、子の重大度ではない。

| 分類 | 投稿先 |
| --- | --- |
| Act On（要対応） | インラインコメント。位置を差分上に置けなければ総評 |
| Consider（要検討） | インラインコメント。位置を差分上に置けなければ総評 |
| Noted（参考） | 投稿しない |
| Dismissed（却下） | 指摘としては投稿しない。確かめた結論は総評の「確認した点」に書ける |

指摘は該当する行の横にあるほうが読みやすいので、Consider もインラインにする。件数を理由に指摘を黙って落とさない。量は本書の3節のプレビューで利用者が調整する。インラインは 100 件までにし、超えた分は総評に回す。

インラインの位置は、hunk から手で数えず、次の一覧から選ぶ。`$SKILL_DIR` は SKILL.md 2節と同じく、このスキルの位置を指す。

```sh
node "$SKILL_DIR/scripts/diff-lines.mjs" "$OUTPUT/reviewed.diff" --path <path>
```

一覧の各行は、コメントを置ける行の `path`、`hunk`、`side`、`line`、`text`（その行の内容）を持つ JSON である。

- 指摘が引用しているコードと `text` を見比べて行を選ぶ。行番号を推測で補わない。
- 選んだ行の `path`、`side`、`line`、`text` を、`plan.json` の thread にそのまま写す。
- 複数行は、同じ `hunk` の中から開始行を選んで `startLine` と `startSide` を足す。同じ `hunk` に収まらなければ、最終行だけを指す。
- 一覧に無い行（呼び出し元など未変更のファイルを含む）を指す指摘は、総評に入れる。

インラインコメントの本文は次の形にする。出典 ID やモデル名は入れない。PR のタイトルと本文の言語に合わせる。

```markdown
🚨 **Act On(要対応)**

- **箇所**: `path:line`
- **問題**: 何が問題か
- **理由**: なぜ問題か。到達経路、短い引用、破られる条件
- **提案**: どう修正すべきか
```

**提案** に具体策が書けなければ、修正案をこしらえず、修正を決めるのに何が必要かを書く。

Consider のインラインは見出しを `⚠️ **Consider(要検討)**` にし、同じ4項目で書く。**問題** には未確定の点を、**理由** には作者に確かめたいことと、それで判断がどう変わるかを書く。重大な問題の可能性が文脈不足で Consider になっているなら、そのことを書き、軽い提案に見せない。

総評は次の形にする。

```markdown
### 総評
<全体の評価を1〜2文。Act On と Consider の件数と、最も重い問題>

- 対象コミット: <repository.commit の先頭 12 桁>
- 自動再レビュー: <n>/<上限> 回目（`--rereview` で起動されたときだけ。SKILL.md 5節）

### Act On(要対応)
差分の外にあり、インラインにできなかったもの。

**1. <指摘の見出し>**

- **箇所**: `path:line`
- **問題**: 何が問題か
- **理由**: なぜ問題か
- **提案**: どう修正すべきか

### Consider(要検討)
差分の外にあり、インラインにできなかったもの。インラインの Consider と同じ4項目を、Act On と同じく番号付きの見出しの下に書く。

### 前回の指摘
resolve する <n> 件、開けたままにする <m> 件。
- [<前回の指摘の見出し>](<最初のコメントの URL>) → <結論と根拠>（`path:line`）。<resolve する／開けたままにする理由>

### 確認した点
- <確かめた懸念や観点> → <結論>（`path:line`）

### 一次資料
- [<資料の名前>](<URL>)

[review-team <版>](https://github.com/yuki777/review-team)による自動レビューです。<レビュアー一覧> に同じ入力でレビューさせ、<リード> が指摘を検証しました。
```

レビューは常に `COMMENT` として投稿する。PR の承認（`APPROVE`）や変更の要求（`REQUEST_CHANGES`）はしない。それは投稿を読んだ利用者が GitHub で行う。承認するかどうかは総評にも書かない。利用者が `APPROVE` や `REQUEST_CHANGES` での投稿を頼んだ場合も `COMMENT` で投稿し、そのことをプレビューで伝える。

`<版>` は manifest の `reviewTeamVersion` をそのまま書く。`null` なら版を省き、リンクの文字列を `review-team` だけにする。投稿の時点のスキルはレビューを実行した版と違うことがあるので、投稿のときに版を取り直さない。

`<レビュアー一覧>` は manifest の `reviewers` から、全員を `<cli>:<requestedModel>:<requestedEffort>` の形で並べる。`status` が `ok` でないレビュアーには、`（失敗: <status>）` を後ろに付ける。これは要求した設定であり、CLI 報告モデルではない。

`<リード>` は、ホストが示す自分のモデル ID と effort を `<model>:<effort>` の形で書く。ホストが effort を示していなければ effort を省く。モデルも示されていなければ「リード」とだけ書く。自己紹介や推測で補わない。

例:

```markdown
[review-team v0.1.0-6-g5f64b59](https://github.com/yuki777/review-team)による自動レビューです。`claude:claude-fable-5-1:high`、`codex:gpt-6-astra:high`、`grok:grok-4.7:high`（失敗: timeout）に同じ入力でレビューさせ、`claude-opus-5-5` が指摘を検証しました。
```

「確認した点」には、指摘がなくても、何を確かめて問題なしとしたかを読み手に伝えるために、次の決まりで書く。

- 新しく書き起こさない。SKILL.md 4節の判定の「確認した点」から写す。Noted は妥当な懸念なので、問題なしとして書かない。
- 1行ごとに、懸念または観点、結論、その根拠の `path:line` を書く。根拠の箇所を示せない行（「全体を確認した」「エッジケースを確認した」など）は書かない。
- 実際に読んでいない箇所を確かめたと書かない。差分しか読んでいなければ、差分の中の箇所だけを根拠にする。
- 出典 ID やモデル名は入れない。
- 5件までにし、判定への影響が大きいものから選ぶ。

「一次資料」には、確認に使った資料のうち、リンクを示せるもの（PR の本文からたどった Issue や仕様、利用者が渡した資料など）を、実際に読んだものだけ書く。PR の差分と対象コミットは「対象コミット」の行で示しているので重ねない。

「前回の指摘」には、本書の2節「前回のスレッド」で扱いを決めた全件を書く。resolve は投稿を確かめたあと（本書の6節）に行うので、「resolve する」と書く。

「良い点」の節は作らない。良い点は「確認した点」の結論として、根拠の箇所と一緒に書く。テストやビルドを実行していないことや、確かめていない範囲を書く欄も作らない。欄があると決まり文句で埋めてしまうからである。

空の見出しは書かない。「前回の指摘」「確認した点」「一次資料」も、書くものがなければ節ごと省く。インラインの指摘は総評に重複させない。

### 前回のスレッド

review-team が前回までに始めたスレッドが PR にあれば、今回の判定と合わせて一件ずつ扱いを決める。初回のレビューのように一件も無ければ、何もせず `previous` を空にする。

スレッドは次のクエリで取る。`hasNextPage` が `true` なら、`endCursor` を `$after` に渡して続きを取る。

```graphql
query($url: URI!, $after: String) {
  resource(url: $url) {
    ... on PullRequest {
      author { login }
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved viewerCanResolve path line
          comments(first: 100) {
            totalCount
            nodes { id url body author { login } pullRequestReview { body } }
          }
        }
      }
    }
  }
}
```

対象にするのは、次のすべてを満たすスレッドだけである。人やほかのボットが始めたスレッドは、内容にかかわらず触れない。

- 最初のコメントの `author.login` が `viewer.login` と同じ。
- 最初のコメントの `pullRequestReview.body` に、総評の末尾の `(https://github.com/yuki777/review-team)` へのリンクがある。
- `isResolved` が `false` で、`totalCount` が 100 以下である。100 を超えるスレッドは全部の発言を読めないので、開けたままにする。

リードは、各スレッドの最初のコメント（前回の指摘）とその後の発言を読み、新しい head のコードを SKILL.md 3節と同じく `git -C <path> show <commit>:<ファイル>` で開いて、次のどれかに決める。

| 結論 | 扱い |
| --- | --- |
| 直った: 指摘した問題が直っていることを、新しい head の `path:line` で確かめた | 返信して resolve する |
| 誤りだった: 前回の指摘そのものが誤りだったと判断した（作者の反論が正しかった場合など） | 誤りを認めて取り下げる返信をして resolve する |
| 一部だけ直った | 残っている点を返信し、開けたままにする |
| 作者が理由を付けて「対応しない」と返した | 返信せず、開けたままにする。受け入れるかは人が決める |
| 直っていない、または確かめられなかった | 返信せず、開けたままにする |

元の指摘は直っていて、別の経路の問題が新しく見つかった場合は、元のスレッドを「直った」として resolve し、新しい問題は今回の指摘として本書の2節の表のとおりに投稿する。

「直った」と「誤りだった」でも、そのスレッドの `viewer.login` の最後のコメントより後に、今回の返信で答えられない他の人の発言があれば resolve しない。答えられる発言は、PR の作者（クエリの `author.login`）の「直しました」「再現しません」のような返答と、リードが正しいと認めた作者の反論だけである。作者かどうかは発言の `author.login` で比べ、文面で推し量らない。質問、作者以外の発言、リードが認めなかった反論があれば、開けたままにして総評で触れる。

開けたままにする前回のスレッドと同じ問題は、新しいインラインに重ねず、総評の「前回の指摘」に書く。

`viewerCanResolve` が `false` のスレッドは、今のアカウントでは resolve できないので、「直った」「誤りだった」でも返信だけにして開けたままにし、そのことを総評に書く。

返信する件（resolve する件、「一部だけ直った」件、resolve できない件）を、`previous` に `thread`、`url`、`action`（resolve するなら `resolve`、返信だけなら `reply`）、`lastComment` を付けて並べる。返信の本文は PR のタイトルと本文の言語に合わせ、次の形にする。`<commit>` は `plan.json` の `commit` の先頭 12 桁、`{{review}}` は本書の6節で今回のレビューの URL に置き換える目印で、そのまま書く。

```markdown
<!-- 直った -->
<commit> で直っていることを確かめました（`path:line`）。詳しくは[今回の総評]({{review}})にあります。

<!-- 誤りだった -->
この指摘は誤りでした。取り下げます。詳しくは[今回の総評]({{review}})にあります。

<!-- 一部だけ直った -->
<commit> で一部が直っています。残っている点: <残る点>（`path:line`）。詳しくは[今回の総評]({{review}})にあります。
```

コメント行（`<!-- -->`）は場合を示すためのもので、本文には入れない。

理由の無いまま閉じると、後から読む人に経緯が分からない。詳しい根拠は総評の「前回の指摘」に書く。

完了条件: Act On と Consider の全件が、インライン・総評・利用者の判断で外したもののどれかに割り当てられている。review-team が始めた未解決の前回のスレッドの全件が、resolve する・返信だけする・開けたままにするのどれかに決まっている。

## 3. プレビューを見せて承認を得る

書き込みの前に、投稿するものを全部そのまま利用者に見せる。

- 投稿先の PR URL、対象コミット、投稿するアカウント（`viewer.login`）。
- 総評の全文。
- インラインコメントごとの `path`、行（範囲なら開始行も）、`side`、その行の内容（`text`）、本文。
- 投稿しないことにした Act On と Consider の一覧。
- resolve するスレッドと返信だけするスレッドごとの URL、付ける返信の本文。開けたままにする前回のスレッドの URL と理由。

利用者が外したり書き換えたりしたら、もう一度全体を見せる。承認されたら、新しい `$ATTEMPT` を作り、承認した内容をそのまま `plan.json`、`summary.md`、`thread-<i>.md`、`previous-<j>.md` に書く。書いたら、各 thread の `path`、`side`、`line`、`text` の組が本書の2節の一覧にあることを確かめる。無ければ位置を選び直し、承認からやり直す。以後はこのファイルだけを投稿し、内容を変えるときは承認からやり直す。

起動時に `--comment` が付いていれば、プレビューへの同意をすでに得たものとして扱う。前回のスレッドへの返信と resolve も、この同意に含む。プレビューは見せるが、返事を待たずに新しい `$ATTEMPT` を書く。書いたあと、各 thread の組が本書の2節の一覧にあるかの照合は、この場合も行う。一覧に無い組があれば、位置を選び直したプレビューを見せ、返事を待たずに新しい `$ATTEMPT` に書く。照合が通ったら本書の4節へ進む。本書の1b と4節の止める条件と、下書きを削除する前の同意は、この場合も省かない。

`--comment` を承認とみなすのは、レビューのあと最初の投稿の流れで見せたプレビューだけである。止まったあとにプレビューからやり直すとき（本書の1a からのやり直しを含む）は、通常どおり返事を待つ。

完了条件: 利用者が承認した内容（`--comment` なら、見せたプレビューの内容）が、新しい `$ATTEMPT` に書かれている。

## 4. 投稿する

レビューを作る直前と提出する直前に、本書の1b の確認をもう一度行う。`viewer.login` が `plan.json` の `login` と違う場合も止める。

下の GraphQL は `$ATTEMPT/<名前>.graphql` に書き出して使う。要求は `plan.json` から `jq` で組み立て、本文をコマンドラインに展開しない。要求と応答は `create`、`thread-<i>`、`submit`、`delete` の名前で置く。本書の1b の状態確認は `state-<n>`、取得クエリは `fetch-<n>` とし、n を 1 から増やす。

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
    thread { id path line startLine diffSide startDiffSide comments(first: 1) { nodes { id } } }
  }
}
```

追加するたびに、応答の `path`、`line`、`diffSide` が `plan.json` の `path`、`line`、`side` と一致することを確かめる。複数行なら `startLine` と `startDiffSide` も `startLine` と `startSide` と比べる。違えば次へ進まず、本書の4節「止めるとき」に従う。

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
- 各コメントの `path` と `line` が、`plan.json` の対応する thread と一致する。
- `totalCount` が `plan.json` の `threads` の件数と等しい。
- コメントの `id` の集合が、各 `thread-<i>.out.json` のコメント ID の集合と等しい。
- 各コメントの `body` が、対応する `thread-<i>.md` と、末尾の改行を除いて同じである。

成り立てば、`summary.md` を総評として、`event` に `COMMENT` を渡して提出する（`submit`）。

```graphql
mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) {
    pullRequestReview { id state url }
  }
}
```

止めるときは、提出せずに理由を利用者へ伝える。

- 自分の下書き（`create` で得た ID）が残っていれば、そのことと現在の中身を伝え、削除するかを利用者に選んでもらう。残すと、同じ PR への次の投稿は本書の1節で止まる。
- 削除に同意を得たら `deletePullRequestReview(input: { pullRequestReviewId: $review })` を送り（`delete`）、取得クエリの結果が `NOT_FOUND` になったことを確かめる。`delete` が結果不明でも、この取得で判定できる。これで試行は終わる。
- 提出の結果が不明なら、取得クエリで状態を確かめる。提出済みなら本書の5節へ進む。`PENDING` のままで、ほかに結果不明の要求が無ければ、`submit-2` の名前で提出を送り直してよい。提出済みのレビューは提出し直せないので、重複しない。

完了条件: 取得したレビューの `state` が `PENDING` 以外になっている。

## 5. 結果を確かめて報告する

本書の4節の取得クエリで提出したレビューを取り直し、承認した内容と照合する。

- `state` が `COMMENTED` である。
- `body` が `summary.md` と、末尾の改行を除いて同じである。
- コメントの件数、`id`、`path`、`line`、`body` が、`plan.json` と各 `thread-<i>` のファイルと一致している。

一致したら、本書の6節で前回のスレッドを片付けてから報告する。

利用者には、レビューの URL と、インラインと総評の件数を伝える。各指摘の出典 ID と、その投稿先（コメントの URL または総評）の対応も伝える。投稿しなかった指摘と、その理由も伝える。resolve したスレッドの URL、返信だけしたスレッドの URL、開けたままにした前回のスレッドとその理由、本書の6節で飛ばした件とその理由も伝える。

完了条件: 投稿されたレビューが GitHub 上で確認でき、承認した内容と一致し、本書の6節を終え、利用者に対応が報告されている。

## 6. 前回のスレッドを片付ける

`plan.json` の `previous` が空なら何もしない。本書の5節で今回のレビューを確かめたあとにだけ行う。投稿が止まった試行（本書の1b・4節）では、返信も resolve もしない。`--rereview` で起動された場合も同じ手順で行う。

始める前に、本書の1b の状態確認をもう一度行い、`viewer.login` が `plan.json` の `login` と同じことも確かめる。`headRefOid` が `plan.json` の `commit` と違えば、確かめたあとに push があり、直ったとした問題が戻っているかもしれないので、どの件も返信も resolve もせずに止め、利用者に伝える。`state` が `OPEN` でなくなっていても同じく止める。

下の GraphQL は、本書の4節と同じく `$ATTEMPT/<名前>.graphql`（`add-reply`、`resolve-thread`、`fetch-thread`）に書き出して使う。`previous` の j 番目（1 から数える）を、一件ずつ順に処理する。要求と応答は `previous-<j>-fetch-<n>`（n は 1 から増やす）、`previous-<j>-reply`、`previous-<j>-resolve` の名前で置く。前の試行の続きで、`previous-<j>-resolve` が成功している件や、`action` が `reply` で `previous-<j>-reply` が成功している件は飛ばす。

まず、返信を組み立てて要求ファイルに書く。`$REVIEW_URL` は本書の5節で取り直したレビューの `url` である。要求ファイルがすでにあれば、組み立て直さずにそれを使う。

```sh
jq -n --rawfile query "$ATTEMPT/add-reply.graphql" --rawfile body "$ATTEMPT/previous-$j.md" \
  --arg url "$REVIEW_URL" --slurpfile plan "$ATTEMPT/plan.json" --argjson j "$j" \
  '{query: $query, variables: {thread: $plan[0].previous[$j - 1].thread,
    body: ($body | gsub("\\{\\{review\\}\\}"; $url))}}' > "$ATTEMPT/previous-$j-reply.json"
```

返信を送る前と resolve を送る前に、そのつどスレッドを取り直す（`previous-<j>-fetch-<n>`）。

```graphql
query($thread: ID!) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      isResolved
      comments(last: 100) { nodes { id body author { login } } }
    }
  }
}
```

取得したコメントのうち、`lastComment` より後のものを見て判定する。

- `isResolved` が `false` で、`lastComment` より後のコメントが無ければ、返信はまだ届いていない。`previous-<j>-reply.out.json` が無ければ返信を送る。結果不明の返信があるなら、送り直さずにこの件を飛ばす。
- `isResolved` が `false` で、`lastComment` より後のコメントがちょうど1件、`viewer.login` のもので本文が要求の `body` と末尾の改行を除いて同じなら、返信は届いている。
- それ以外（プレビューのあとに他の発言がある、`lastComment` が取得したコメントの中に無い、`NOT_FOUND`、すでに resolve されている）なら、この件は以後、返信も resolve もせずに飛ばす。

返信は次の要求で送る（`previous-<j>-reply`）。成功は、応答にコメントの `id` があることで判断する。

```graphql
mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id url }
  }
}
```

`action` が `resolve` なら、取り直して返信が届いていることと、ほかに新しい発言が無いことを上の判定で確かめてから、スレッドを resolve する（`previous-<j>-resolve`）。返信を送ってから resolve するまでの間に他の発言があれば、resolve せずに飛ばす。

```graphql
mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) {
    thread { id isResolved }
  }
}
```

応答の `isResolved` が `true` でも、スレッドを取り直して `isResolved` が `true` であることを確かめる。結果不明のときもこの取得で判定し、まだ `false` なら `previous-<j>-resolve-2` の名前で一度だけ送り直してよい。resolve は重ねても結果が変わらない。

飛ばした件や確かめられなかった件があっても、残りの件は続ける。今回のレビューはすでに投稿されているので、ここで下書きの削除や投稿のやり直しはしない。

完了条件: `previous` の各件が、取り直した状態で返信済み（`resolve` なら `isResolved` が `true`）か、飛ばした理由が分かっている。
