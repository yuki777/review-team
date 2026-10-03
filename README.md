# review-team

同じ変更を、Claude Code・Codex・Grok の CLI で動かす複数のモデルに独立してレビューさせ、主担当の AI が全指摘を根拠付きで判定するスキルです。コードは変更しません。

pstack の [interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate) をもとにしています。pstack のインストールは不要です。

## 必要なもの

- Node.js 22 以降、macOS または Linux
- 使うレビュアーの CLI（`claude`、`codex`、`grok`）と、それぞれのログイン

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

### シンプルな使い方

レビューしたいリポジトリで、AI にスキル名を付けて頼みます。

| ホスト | 頼み方 |
| --- | --- |
| Claude Code | `/review-team このブランチの変更をレビューして` |
| Codex | `$review-team このブランチの変更をレビューして` |

主担当の AI が次の順で進めます。

1. 変更の意図と差分をまとめます。
2. 対象コミットの読み取り専用クローンを作り、レビュアー全員に渡します。各レビュアーは呼び出し元やテストも読んで裏付けを取ります。
3. レビュアーが並列で独立にレビューします（既定は Claude Fable 5.1・Codex GPT 6 Astra・Grok 4.7、effort はすべて high）。
4. 主担当が根拠を確かめ、全指摘を次の4つに分類して報告します。

| 分類 | 意味 |
| --- | --- |
| Act On（要対応） | 修正すべき具体的な問題 |
| Consider（要検討） | 妥当だが、対応する価値とコストを検討する必要がある |
| Noted（参考） | 妥当だが、今は対応不要 |
| Dismissed（却下） | 誤検知・前提違い・好みの差。却下の理由も残す |

### オプションを付けた使い方

頼むときに言葉で指定すれば、主担当がオプションに変換します。

| 頼み方の例 | 内容 |
| --- | --- |
| `/review-team Claude Opus 5.5 と Claude Fable 5.1 と GPT 6 Astra でレビューして` | レビュアーの組み合わせを変える。同じ CLI の別モデルも並べられる |
| `/review-team Claude は effort max でレビューして` | レビュアーごとの reasoning effort を変える |
| `/review-team Grok は sandbox なしでレビューして` | Grok の sandbox を使わずに起動する（下の「注意」を参照） |
| `/review-team リポジトリは読ませずに差分だけでレビューして` | クローンを渡さず、まとめた資料だけでレビューする |
| `/review-team コミット abc123 の状態でレビューして` | クローンするコミットを指定する |
| `/review-team 制限時間30分でレビューして` | レビュアーごとの制限時間を変える（既定20分） |

既定のレビュアーの一覧は `~/.agents/skills/review-team/config/reviewers.json` にあります。このファイルは更新のたびに上書きされるので、組み合わせを変えたいときは頼むときに指定してください。

## 注意

- **コードの送信先**：レビュー対象のコードは、使うレビュアーの各社サービスへ送られます。秘密情報を含む変更では使わないでください。
- **読み取り専用の仕組み**：レビュアーが読むのはユーザーの作業ツリーではなく、書き込み権限を外したクローンです。Claude と Grok は読み取り系ツールだけを使えます。Codex はファイルを読むためにシェルを使い、read-only sandbox が書き込みと通信を止めます。
- **クローン外の読み取り**：Codex と、sandbox なしの Grok は、クローンの外のファイルも読める可能性があります。
- **Grok の sandbox**：`/var/run/docker.sock` がシンボリックリンクの macOS（OrbStack など）では、Grok の sandbox が起動しません。その環境では「Grok は sandbox なしで」と頼んでください。
- **モデル名**：結果に記録されるモデル名は CLI が報告した値です。サーバーが実際に使ったモデルの証明ではありません。
- **古い CLI が使われる場合**：Node のバージョン管理ツールによっては、古い CLI が先に見つかります。環境変数 `REVIEW_TEAM_CLAUDE_CLI`、`REVIEW_TEAM_CODEX_CLI`、`REVIEW_TEAM_GROK_CLI` で CLI の絶対パスを指定できます。

## ライセンス

MIT です。pstack interrogate から取り込んだ部分の著作権表示（Copyright (c) 2026 Lauren Tan）は [LICENSE.pstack](skills/review-team/LICENSE.pstack) に残しています。
