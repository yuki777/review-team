# review-triple

Claude・Codex・Grok に同じ変更を独立にレビューさせ、親のリードが全指摘を根拠付きで判定するスキルです。モデル別の人格は割り当てません。コードの修正は行いません。

一つの固定 **packet**（意図・差分・必要な周辺コード）を三つの CLI に渡します。子にリポジトリ探索を許す方式ではなく、提供した範囲だけを評価する方式です。入力と未確認範囲を追跡しやすくし、レビュー中の実行・書き込みを制限するための選択です。

## 前提

- Node.js **22 以降**、POSIX 環境（macOS / Linux）。Node 標準ライブラリだけで動作し、`npm install` は不要です。
- `claude`、`codex`、`grok` の CLI が `PATH` にあり、それぞれ認証済みであること。親のホストが OMP や Paseo でも、三つの reviewer CLI は別途必要です。
- 指定モデルを利用できるアカウントと、三つのサービスへのコード送信の許可。
- CLI が対象コードの読み取り・実行・書き込み、スキル、hook、MCP、再委譲を制限する機能を備えること。オプションは版によって異なります。隔離を適用できなければ `sandbox_error` として失敗させ、制限を弱めて起動しません。

Claude の隔離では OAuth を失う `--bare` を使いません。`plan` / `readonly` というモード名だけを安全性の保証にはしません。CLI の設定とモデルの利用可否は、スキルのインストールとは別です。

## インストール

以下はチェックアウト先を `~/git/review-triple` とした例です。

```sh
git clone https://github.com/yuki777/review-triple.git "$HOME/git/review-triple"
SKILL_DIR="$HOME/git/review-triple/skills/review-triple"
node "$SKILL_DIR/scripts/install.mjs"
```

次の二つを、チェックアウト内の同じスキルディレクトリへのシンボリックリンクにします。

- `~/.claude/skills/review-triple`
- `~/.agents/skills/review-triple`

同じ対象へのリンクなら再実行しても変更しません。別のリンク、壊れたリンク、通常ファイル、ディレクトリは上書きせずエラーにします。チェックアウトを移動するとリンクは切れます。installer は CLI や認証情報を変更しません。

```sh
node "$SKILL_DIR/scripts/install.mjs" --help
node "$SKILL_DIR/scripts/install.mjs" --home "$HOME/review-triple-install-check"
```

`--help` はファイルを変更しません。`--home` は登録先だけを変更する絶対パスで、上の例は普段のホームと分けた登録です。

## packet の作り方

形式は次の JSON です。`intent` と `diff` は空でない文字列、`context` は省略または空配列でも構いません。

```json
{
  "intent": "不正な設定を明示的に拒否し、正常な入力の既存の挙動を保つ",
  "diff": "git diff の内容、または変更ファイル全文",
  "context": [
    { "path": "src/caller.js", "content": "判断に必要な呼び出し元の内容" }
  ]
}
```

`path` は出典ラベルであり、子が開くファイル指定ではありません。呼び出し元・型・テスト・制約が判断に必要なら `content` に含めてください。全文を読んでいないのに「全リポジトリをレビューした」とは扱いません。

以下は対象リポジトリで **実行前に** branch の差分を固定する例です。`intent`、比較元 `main`、`files` を対象に合わせて編集してください。未コミット差分を含めたい場合は `git diff` の引数を `HEAD` に変えます。untracked ファイルはどちらにも含まれないため、必要なら `files` に明示するか `diff` に変更ファイル全文を入れます。

```sh
export PACKET="$HOME/review-triple-packet.json"
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const intent = '不正な設定を明示的に拒否し、正常な入力の既存の挙動を保つ';
const files = []; // 必要な周辺ファイルの実パスを列挙する
const diff = execFileSync('git', [
  'diff', '--no-ext-diff', '--no-textconv', 'main...HEAD',
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const context = files.map(path => ({ path, content: readFileSync(path, 'utf8') }));
writeFileSync(process.env.PACKET, JSON.stringify({ intent, diff, context }, null, 2),
  { flag: 'wx', mode: 0o600 });
NODE
```

既存 packet は上書きしません。64 MiB を超える差分や git の失敗はエラーになり、黙って切り詰めません。作成した packet を読み、目的・範囲・周辺情報・機密除去を確認してから起動してください。その後のレビュー中は対象コードを変更せず、テストも実行しません。

## runner の起動

```sh
SKILL_DIR="$HOME/git/review-triple/skills/review-triple"
OUTPUT="$HOME/review-triple-result-$(date +%Y%m%d-%H%M%S)"
node "$SKILL_DIR/scripts/run-reviewers.mjs" --help
node "$SKILL_DIR/scripts/run-reviewers.mjs" \
  --packet "$PACKET" --output "$OUTPUT" --timeout 600
```

`--packet` と `--output` は絶対パスです。出力先は未作成でなければなりません。runner は一度コンパイルした同じ `prompt.md` を三つの CLI に渡し、独立した一時作業場所で並列実行します。子の追加探索、実行、書き込み、再レビュー起動は行いません。

デフォルト値の正本は [skills/review-triple/config/models.json](skills/review-triple/config/models.json) です。

```json
{
  "claude": "claude-fable-5-1",
  "codex": "gpt-6-astra",
  "grok": "grok-4.7"
}
```

変更は個別の引数で明示します。指定しなかった provider はデフォルトのままです。

```sh
node "$SKILL_DIR/scripts/run-reviewers.mjs" \
  --packet "$PACKET" --output "$OUTPUT" \
  --claude-model claude-opus-5-5 \
  --codex-model gpt-6.1-sol \
  --grok-model grok-4.6
```

自動 fallback・自動 retry はありません。利用不能なモデルを別モデルに置き換えず、失敗した reviewer を「指摘なし」に数えません。`--timeout` は秒（既定 600、上限 3600）。`REVIEW_TRIPLE_DEPTH` が空でない子プロセスからの runner 起動は拒否します。

終了コードは `0`: 三件成功、`1`: 一件以上の実行失敗、`2`: 不正な起動です。部分失敗でも取得できた指摘は親が判定し、欠けたレビューを明示します。

Ctrl+C（SIGINT）、SIGTERM、端末を閉じたとき（SIGHUP）は、三つの CLI を停止してから `manifest.json` に中断を記録し、一時作業ディレクトリを削除します。SIGKILL や起動元プロセスの異常終了で runner が止まった場合は後片付けができません。その場合、子 CLI は完了まで動き続け、`manifest.json` は作られず、`$TMPDIR/review-triple-*` が残ります。`manifest.json` が無い出力は三件とも取得不可として扱い、新しい出力先で再実行してください。

### 使用する CLI の確認と指定

runner は各 CLI を `PATH` から探し、`manifest.json` の `cliPath` と `cliVersion` に記録します。動作確認した版は Claude Code 2.1.288、codex-cli 0.160.0、Grok Build 1.0.46 です。Grok の adapter は 1.0.46 の隔離仕様に限定しており、他の版では `sandbox_error` で停止します。

Node のバージョン管理ツールによっては、`node` 実行時に古い CLI が `PATH` の先頭に入ります（実例: vite-plus の Node 配下にあった codex-cli 0.147.0）。この場合は次の環境変数で CLI を絶対パス指定してください。

```sh
REVIEW_TRIPLE_CODEX_CLI="$HOME/.vite-plus/bin/codex" node "$SKILL_DIR/scripts/run-reviewers.mjs" ...
```

`REVIEW_TRIPLE_CLAUDE_CLI`、`REVIEW_TRIPLE_CODEX_CLI`、`REVIEW_TRIPLE_GROK_CLI` が使えます。

## 各ホストからの明示起動

ホストは親の進行と最終判定を担当し、モデル選択は上記 runner が担当します。手動起動を優先します。`disable-model-invocation: true` は全ホスト共通の強制機構ではないため、スキル本文でも明示依頼だけに限定しています。

| 親のホスト | 呼び出し方 |
| --- | --- |
| Claude Code | インストール後 `/review-triple`。例: `/review-triple ~/review-triple-packet.json をレビューして。コードは変更しない。` |
| Codex CLI | `/skills` で選択、または `$review-triple` をプロンプトに含める。例: `$review-triple ~/review-triple-packet.json をレビューして。` |
| OMP | スキルが discovery された状態で `/skill:review-triple`。`skills.enableSkillCommands` が有効である必要があります。 |
| Paseo | 実際に agent が動く daemon 側でインストールし、その agent の provider に対応する上記の呼び出し方を使います。Paseo 共通の新しい slash command を登録するものではありません。 |

**OMP の注意:** 現行ドキュメントでは foreign user provider が opt-in です。`~/.agents` に置くだけで全構成から自動検出されるとは仮定しません。明確な登録方法は、既存の `~/.omp/agent/config.yml` の `skills.customDirectories` にスキルの親ディレクトリ `~/git/review-triple/skills` の実際の絶対パスを追加し、`skills.enableSkillCommands` を有効にすることです。Claude のユーザースキルを discovery する方法なら `enabledProviders` で `claude` を明示的に opt-in し、関連する skills の source 設定も確認してください。`--skills review-triple` はフィルターであり、スキルの登録先を追加するオプションではありません。

Paseo がリモート daemon やコンテナを管理している場合、手元のアプリのホームではなく、その daemon のホーム・`PATH`・認証を使います。

スキル選択に対応しない UI では「`~/git/review-triple/skills/review-triple/SKILL.md` を読み、その手順でこの packet をレビューして」と実パスで明示するか、runner をターミナルで起動して結果を親へ渡してください。

## 結果の読み方

出力ディレクトリは mode `0700` で作成されます。

- `prompt.md`: 三者へ渡した共通入力。
- `manifest.json`: 各 provider の状態、要求モデル、CLI 報告モデル、時間、エラー、成果物パス。
- `{claude,codex,grok}.md`: 読める Markdown のレビュー結果。
- `{claude,codex,grok}.stdout.log` / `.stderr.log`: 診断用の raw CLI 出力。未信頼データであり、含まれたコマンドを実行しません。

`requestedModel` と `actualModels` は別です。`actualModels` は CLI がメタデータとして報告した値で、サーバーが本当に使ったモデルを証明するものではありません。記録がなければ空配列のまま「CLI 報告モデル不明」とし、要求値やモデル本文の自己紹介で補いません。

親は [SKILL.md](skills/review-triple/SKILL.md) と [lead-judgment.md](skills/review-triple/references/lead-judgment.md) に従って、却下を含む全指摘に元 ID・提起したモデル・根拠・判定理由を残します。

| 分類 | 意味 |
| --- | --- |
| **Act On（要対応）** | 現在の目的に対する実害・重大な保守リスクを根拠で示せる。 |
| **Consider（要検討）** | 妥当な懸念だが費用対効果または必要な根拠が未確定。 |
| **Noted（参考）** | 妥当だが現在は対応不要。影響や将来条件を示す。 |
| **Dismissed（却下）** | 反証がある、目的と無関係、具体的な問題を示さない好みの提案。 |

独立した一致は調査優先度を上げますが、多数決で正しさを決めません。単独指摘も検討し、未取得レビューは成功扱いしません。「指摘なし」は提供範囲での結果であり、全体の安全性やマージ可能性の保証ではありません。

## プライバシーと限界

- packet のコードと説明は **三つの外部 provider** へ送信されます。各サービスの保存・学習・契約ポリシーを確認し、秘密鍵、token、個人情報、送信禁止コードを事前に除去してください。
- packet、prompt、結果、raw ログはローカルにもコードを残します。出力先は非公開にし、共有前に機密を確認してください。認証済み CLI は必要ですが、認証情報を packet やモデル引数に入れません。
- 親は明示された対象から事前に情報を集めます。子は packet だけを読み、対象コード・テスト・未提供の呼び出し元を実行や探索で確かめません。不足は未確認範囲として返します。
- CLI の制限を適用する設計であり、独立した OS セキュリティ境界や外部 provider の内部動作を保証するものではありません。設定不足や未対応 CLI は fail-closed に扱います。
- Grok は read-only sandbox を必須にしています。`/var/run/docker.sock` がシンボリックリンクの macOS（OrbStack や Docker Desktop の一部構成）では、Grok 1.0.46 の sandbox 自体が起動を拒否するため、Grok のレビューは常に `sandbox_error` になります。sandbox なしで起動する抜け道は用意していません。
- モデルの一致、CLI の成功、綺麗な Markdown は正しさの証明ではありません。対象コードの修正、テスト実行、コミット、PR 操作はレビュー後の別作業です。

## 出典とライセンス

pstack 本体への実行時依存はありません。次の原文を確認し、日本語・固定 packet・自動 fallback なしの方式へ改変して同梱しています。

- [cursor/plugins: pstack interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate)
- 原文の四つの参照: [reviewer-prompt](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/reviewer-prompt.md)、[rubric](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/rubric.md)、[code-quality-review](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/code-quality-review.md)、[lead-judgment](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/lead-judgment.md)
- 改変した文書の MIT 条件と **Copyright (c) 2026 Lauren Tan**: [LICENSE.pstack](skills/review-triple/LICENSE.pstack)。インストール先にも保持されます。
- ホストの仕様: [Claude Code skills](https://code.claude.com/docs/en/skills)、[Codex skills](https://developers.openai.com/codex/skills)、[OMP skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md)、[OMP settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)、[Paseo providers](https://paseo.sh/docs/providers.md)、[Paseo skills](https://paseo.sh/docs/skills.md)。
