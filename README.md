# review-team

同じ変更を、Claude Code・Codex の CLI で動かす複数のモデルに独立してレビューさせ、主担当の AI が全指摘を根拠付きで判定するスキルです。コードは変更しません。

pstack の [interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate) をもとにしています。pstack のインストールは不要です。

## 必要なもの

- Node.js 22 以降、macOS または Linux
- 使うレビュアーの CLI と、それぞれのログイン。既定は `claude`・`codex`

## インストール

```sh
npx skills add yuki777/review-team -g -a claude-code -a codex -y
```

`~/.agents/skills/review-team` に入り、`~/.claude/skills/review-team` からリンクされます。

## 更新

```sh
npx skills update review-team -g
```

## アンインストール

```sh
npx skills remove review-team -g
```

## 使い方

## Claude Code / Codex から（`/review-team`）

レビューしたいリポジトリで、スキル名を付けて頼みます（Codex では `$review-team`）。

```
/review-team <PR-URL>
```

主担当の AI が、変更の意図と差分をまとめ、レビュアー全員に同じ資料と対象コミットの読み取り専用クローンを渡して並列にレビューさせ、全指摘の根拠を確かめて次の4つに分類して報告します。

| 分類 | 意味 |
| --- | --- |
| Act On（要対応） | 修正すべき具体的な問題 |
| Consider（要検討） | 妥当だが、対応する価値とコストを検討する必要がある |
| Noted（参考） | 妥当だが、今は対応不要 |
| Dismissed（却下） | 誤検知・前提違い・好みの差。却下の理由も残す |

| 引数・オプション | 内容 |
| --- | --- |
| `<PR-URL>` / PR 番号 / ブランチ名 | レビューする対象。省略すると、現在のブランチと既定ブランチの差分 |
| `--comment` | プレビューの承認を待たずに PR へ投稿する（Act On をインラインコメントと総評に。Noted と Dismissed は投稿せず、Consider も `--with-consider` が無ければ投稿しない）。付けなくても、レビュー後に「PR にコメントして」と頼めばプレビューを見せてから投稿する |
| `--with-consider` | Consider も PR に投稿する（既定は Act On だけ） |
| `--watch` | 投稿後も PR を見回り、push のたびに自動で再レビューして投稿する（1分ごとの見回りを launchd に登録。PR のマージかクローズ、6時間、再レビュー5回のどれかで解除） |
| `--reviewer <cli>:<model>:<effort>` | レビュアーを指定する（1人につき1つ。既定の一覧を丸ごと置き換える）。`cli` は `claude` / `codex` |
| 言葉での指定 | 「Fable も加えて」「Claude は effort max で」「制限時間30分で」「コミット abc123 の状態で」なども、主担当がオプションに変換する |

既定のレビュアーは Claude Opus 5.5・Codex GPT 6 Astra（effort はどちらも xhigh）で、[config/reviewers.json](skills/review-team/config/reviewers.json) にあります。

## コマンドで（`rt`）

同梱の `scripts/rt` は、どのディレクトリから実行しても、状態ディレクトリ（`${XDG_STATE_HOME:-~/.local/state}/review-team`）で claude を起動して `/review-team --comment --watch <PR-URL>` を実行するコマンドです。つまり、プレビューの承認を待たずに PR へ Act On の指摘を投稿し、以後の push も、落ち着いてから自動で再レビューします（見回りの登録と解除の条件は上の `--watch`）。PATH の通ったディレクトリにリンクを張って使います。
### rtスクリプトをInstall(初回だけ)
```sh
mkdir -p ~/.local/bin && ln -s ~/.agents/skills/review-team/scripts/rt ~/.local/bin/rt
```
### rtスクリプトでreview-teamを実行する
```
rt <PR-URL>
```

各オプションの詳しい説明・メンバーの一覧・例は `rt --help` で見られます。

| 引数・オプション | 付けると何が起こるか |
| --- | --- |
| `<PR-URL>` | その PR をレビューして投稿し、以後の push も自動で再レビューする |
| `--team <TEAM>` | レビュアーを、既定（config/reviewers.json）の代わりに TEAM の顔ぶれにする。TEAM はメンバー名の `-` つなぎ（例: `opus-sol`、`opus:max-sol:xhigh`）。メンバーは `opus` `fable` `sol` `astra`、`:<effort>` を省くと high |
| `--with-consider` | Act On に加えて Consider も PR に投稿する（付けないと Act On だけ） |
| `--print` | 対話画面を出さずに `claude -p` で動かし、レビューと投稿が終わるまで待ってから戻る（launchd などから呼ぶとき用） |
| `--loop --org <組織>` | PR を1件指定する代わりに、自分にレビュー依頼が来ている PR を探してレビューする scan を繰り返す。scan が終わるたびに `--interval` 分待つ。Ctrl-C で止まる |
| `--repo <名前>` | `--loop` で探す範囲を、組織の中のこのリポジトリに絞る（複数回指定できる） |
| `--interval <分>` | `--loop` で scan と scan の間に待つ分（既定 15） |
| `-h`, `--help` / `--version` | ヘルプ / 版を出して終わる |

`--loop` は、コンフリクトや CI の失敗・実行中の PR、ウォッチ中の PR、同じ head でレビュー済みの PR を見送ります。レビューできる PR が無い回は GitHub の検索だけで終わり、claude は起動しません。

## リリース

[tagpr](https://github.com/Songmu/tagpr) が、main へのマージのたびにリリース用の PR を作り直します。その PR をマージすると、`skills/review-team/VERSION` の版でタグと GitHub Release が作られます。版は既定で patch が上がり、PR に `tagpr:minor` か `tagpr:major` のラベルを付けると上げ幅が変わります。VERSION を手で書き換える必要はありません。tagpr が PR を作れるよう、リポジトリの Settings > Actions > General > Workflow permissions で「Allow GitHub Actions to create and approve pull requests」を有効にしておきます。

レビューの記録（`manifest.json` の `reviewTeamVersion`）には、このリポジトリのチェックアウトから動かしたときは `git describe` の値、`npx skills` で入れたときは VERSION の値が入ります。

## ライセンス

MIT です。pstack interrogate から取り込んだ部分の著作権表示（Copyright (c) 2026 Lauren Tan）は [LICENSE.pstack](skills/review-team/LICENSE.pstack) に残しています。
