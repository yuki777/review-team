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
| `/review-team Grok は sandbox なしでレビューして` | Grok の sandbox を使わずに起動する（OrbStack など、Grok の sandbox が起動しない環境向け） |
| `/review-team リポジトリは読ませずに差分だけでレビューして` | クローンを渡さず、まとめた資料だけでレビューする |
| `/review-team コミット abc123 の状態でレビューして` | クローンするコミットを指定する |
| `/review-team 制限時間30分でレビューして` | レビュアーごとの制限時間を変える（既定20分） |

### レビュアーをオプションで指定する

`--reviewer <cli>:<model>:<effort>` を、レビュアー1人につき1つずつ書きます。指定すると、既定のレビュアーの一覧を丸ごと置き換えます。

既定と同じ3人（Claude Fable 5.1・Codex GPT 6 Astra・Grok 4.7）を明示する場合:

```
/review-team --reviewer claude:claude-fable-5-1:high --reviewer codex:gpt-6-astra:high --reviewer grok:grok-4.7:high [PR-URL or PR-Number or Branch]
```

Grok のサブスクリプションがない場合（Claude 2人と Codex 1人）:

```
/review-team --reviewer claude:claude-fable-5-1:high --reviewer claude:claude-opus-5-5:high --reviewer codex:gpt-6.1-sol:high [PR-URL or PR-Number or Branch]
```

Grok と Codex のサブスクリプションがない場合（Claude 3人）:

```
/review-team --reviewer claude:claude-fable-5-1:high --reviewer claude:claude-opus-5-5:high --reviewer claude:claude-sonnet-5-5:high [PR-URL or PR-Number or Branch]
```

既定のレビュアーの一覧は `~/.agents/skills/review-team/config/reviewers.json` にあります。このファイルは更新のたびに上書きされるので、組み合わせを変えたいときは頼むときに指定してください。

## ライセンス

MIT です。pstack interrogate から取り込んだ部分の著作権表示（Copyright (c) 2026 Lauren Tan）は [LICENSE.pstack](skills/review-team/LICENSE.pstack) に残しています。
