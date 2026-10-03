# review-team

Claude Code・Codex・Grok の CLI を使い、好きなモデルの組み合わせで同じ変更を独立にレビューさせ、親のリードが全指摘を根拠付きで判定するスキルです。モデル別の人格は割り当てません。コードの修正は行いません。

意図・差分・必要な周辺コードをまとめた **packet** を、設定したレビュアー全員に渡します。`--repo` で対象リポジトリを指定すると、pstack interrogate と同じく、各レビュアーがリポジトリを読み取り専用で探索して裏付けを取れます。レビュアーが読むのはユーザーの作業ツリーではなく、runner が作る書き込み不可のクローンです。

## 前提

- Node.js **22 以降**、POSIX 環境（macOS / Linux）。Node 標準ライブラリだけで動作し、`npm install` は不要です。
- 使うレビュアーの CLI（`claude`、`codex`、`grok` のうち必要なもの）が `PATH` にあり、それぞれ認証済みであること。親のホストが OMP や Paseo でも、レビュアーの CLI は別途必要です。
- 指定モデルを利用できるアカウントと、使う各サービスへのコード送信の許可。
- CLI が対象コードの読み取り・実行・書き込み、スキル、hook、MCP、再委譲を制限する機能を備えること。オプションは版によって異なります。隔離を適用できなければ `sandbox_error` として失敗させ、制限を弱めて起動しません。

Claude の隔離では OAuth を失う `--bare` を使いません。`plan` / `readonly` というモード名だけを安全性の保証にはしません。CLI の設定とモデルの利用可否は、スキルのインストールとは別です。

## インストール

[skills](https://github.com/vercel-labs/skills) CLI でインストールします。

```sh
npx skills add yuki777/review-team -g -a claude-code -a codex -y
```

- 本体は `~/.agents/skills/review-team` に置かれ、`~/.claude/skills/review-team` はそこへのシンボリックリンクになります。Codex と OMP は `~/.agents/skills`、Claude Code は `~/.claude/skills` を読みます。
- 更新は `npx skills update review-team -g`、削除は `npx skills remove review-team -g` です。
- インストールはスキルの配置だけです。レビュアーの CLI（`claude`、`codex`、`grok`）のインストールと認証は別途必要です。

以降の例では、スキルの場所を次のように置きます。

```sh
SKILL_DIR="$HOME/.agents/skills/review-team"
```

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
export PACKET="$HOME/review-team-packet.json"
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
SKILL_DIR="$HOME/.agents/skills/review-team"
OUTPUT="$HOME/review-team-result-$(date +%Y%m%d-%H%M%S)"
node "$SKILL_DIR/scripts/run-reviewers.mjs" --help
node "$SKILL_DIR/scripts/run-reviewers.mjs" \
  --packet "$PACKET" --output "$OUTPUT" --timeout 1200
```

`--packet` と `--output` は絶対パスです。出力先は未作成でなければなりません。runner は一度コンパイルした同じ `prompt.md` を全レビュアーに渡し、独立した一時作業場所で並列実行します。子のコマンドによる書き込み・通信、再レビュー起動は行いません。

### 対象リポジトリを読ませる（`--repo`）

```sh
node "$SKILL_DIR/scripts/run-reviewers.mjs" \
  --packet "$PACKET" --output "$OUTPUT" --repo "$HOME/git/my-project" --ref HEAD
```

- runner は `--ref`（既定 `HEAD`）のコミットを `${XDG_STATE_HOME:-$HOME/.local/state}/review-team/runs/run-*/src` に `git clone --local` し、書き込み権限を外してから全レビュアーに読ませます。実行が終わるとクローンを削除します。
- 未コミットの変更はクローンに含まれません。packet の `diff` に入れてください。
- CLI ごとの読み方は次のとおりです。
  - Claude: `Read` / `Grep` / `Glob` だけを許可し、`--add-dir` でクローンを追加します。読めるのは作業場所とクローンだけです。
  - Codex: ファイルを読むためにシェルを使います。read-only sandbox が書き込みと通信を止めますが、読み取りはクローンの外にも及びます。
  - Grok: 読み取り・一覧・grep・glob のツールだけを許可し、書き込み・シェル・Web は拒否します。
- クローン内の `AGENTS.md` や `CLAUDE.md` は指示として読み込まず、検討対象データとして扱います。
- `manifest.json` の `repository` に、元のパス・`ref`・コミット ID を記録します。

`--repo` を指定しない場合は、packet だけでレビューします。

### レビュアーの組み合わせ

レビュアーの一覧の既定値は [skills/review-team/config/reviewers.json](skills/review-team/config/reviewers.json) です。

```json
{
  "reviewers": [
    { "cli": "claude", "model": "claude-fable-5-1", "effort": "high" },
    { "cli": "codex", "model": "gpt-6-astra", "effort": "high" },
    { "cli": "grok", "model": "grok-4.7", "effort": "high" }
  ]
}
```

- `cli` は `claude` / `codex` / `grok` のどれかです。各 CLI は自社のモデルだけを動かせます。
- 同じ CLI を何人でも並べられます。人数も自由です（1人以上）。例えば Claude を2人と Codex を1人にもできます。
- `effort` は各 CLI の reasoning effort（推論の深さ）で、省略すると `high` です。Claude は `--effort`、Codex は `model_reasoning_effort`、Grok は `--reasoning-effort` に渡します。使える値は CLI ごとに異なります（例: Claude は `low` / `medium` / `high` / `xhigh` / `max`）。Codex は隔離のため普段の設定ファイルを読まないので、指定しないと推論なし（`none`）で動きます。

実行時だけ変えるときは `--reviewer <cli>:<model>[:<effort>]` を繰り返し指定します。1つでも指定すると、`reviewers.json` の一覧を丸ごと置き換えます。

```sh
node "$SKILL_DIR/scripts/run-reviewers.mjs" \
  --packet "$PACKET" --output "$OUTPUT" \
  --reviewer claude:claude-opus-5-5 \
  --reviewer claude:claude-fable-5-1:max \
  --reviewer codex:gpt-6-astra
```

各レビュアーには ID が付きます。同じ CLI が1人だけなら `claude`、複数なら `claude-1`、`claude-2` のように連番です。出力ファイル名と `manifest.json` はこの ID で区別し、指定したモデルと effort を `requestedModel` と `requestedEffort` に記録します。

自動 fallback・自動 retry はありません。利用不能なモデルを別モデルに置き換えず、失敗した reviewer を「指摘なし」に数えません。`--timeout` は秒（既定 1200、上限 3600。`--repo` で探索すると Grok は約9分かかった実績があります）。`REVIEW_TEAM_DEPTH` が空でない子プロセスからの runner 起動は拒否します。

終了コードは `0`: 全員成功、`1`: 一人以上の実行失敗、`2`: 不正な起動です。部分失敗でも取得できた指摘は親が判定し、欠けたレビューを明示します。

Ctrl+C（SIGINT）、SIGTERM、端末を閉じたとき（SIGHUP）は、全レビュアーの CLI を停止してから `manifest.json` に中断を記録し、一時作業ディレクトリを削除します。SIGKILL や起動元プロセスの異常終了で runner が止まった場合は後片付けができません。その場合、子 CLI は完了まで動き続け、`manifest.json` は作られず、`$TMPDIR/review-team-*` が残ります。`manifest.json` が無い出力は全員分を取得不可として扱い、新しい出力先で再実行してください。

### 使用する CLI の確認と指定

runner は各 CLI を `PATH` から探し、`manifest.json` の `cliPath` と `cliVersion` に記録します。動作確認した版は Claude Code 2.1.288、codex-cli 0.160.0、Grok Build 1.0.46 です。Grok の adapter は 1.0.46 の隔離仕様に限定しており、他の版では `sandbox_error` で停止します。

Node のバージョン管理ツールによっては、`node` 実行時に古い CLI が `PATH` の先頭に入ります（実例: vite-plus の Node 配下にあった codex-cli 0.147.0）。この場合は次の環境変数で CLI を絶対パス指定してください。

```sh
REVIEW_TEAM_CODEX_CLI="$HOME/.vite-plus/bin/codex" node "$SKILL_DIR/scripts/run-reviewers.mjs" ...
```

`REVIEW_TEAM_CLAUDE_CLI`、`REVIEW_TEAM_CODEX_CLI`、`REVIEW_TEAM_GROK_CLI` が使えます。

## 各ホストからの明示起動

ホストは親の進行と最終判定を担当し、モデル選択は上記 runner が担当します。手動起動を優先します。`disable-model-invocation: true` は全ホスト共通の強制機構ではないため、スキル本文でも明示依頼だけに限定しています。

| 親のホスト | 呼び出し方 |
| --- | --- |
| Claude Code | インストール後 `/review-team`。例: `/review-team ~/review-team-packet.json をレビューして。コードは変更しない。` |
| Codex CLI | `/skills` で選択、または `$review-team` をプロンプトに含める。例: `$review-team ~/review-team-packet.json をレビューして。` |
| OMP | スキルが discovery された状態で `/skill:review-team`。`skills.enableSkillCommands` が有効である必要があります。 |
| Paseo | 実際に agent が動く daemon 側でインストールし、その agent の provider に対応する上記の呼び出し方を使います。Paseo 共通の新しい slash command を登録するものではありません。 |

**OMP の注意:** 現行ドキュメントでは foreign user provider が opt-in です。`~/.agents` に置くだけで全構成から自動検出されるとは仮定しません。明確な登録方法は、既存の `~/.omp/agent/config.yml` の `skills.customDirectories` に `~/.agents/skills` の実際の絶対パスを追加し、`skills.enableSkillCommands` を有効にすることです。Claude のユーザースキルを discovery する方法なら `enabledProviders` で `claude` を明示的に opt-in し、関連する skills の source 設定も確認してください。`--skills review-team` はフィルターであり、スキルの登録先を追加するオプションではありません。

Paseo がリモート daemon やコンテナを管理している場合、手元のアプリのホームではなく、その daemon のホーム・`PATH`・認証を使います。

スキル選択に対応しない UI では「`~/.agents/skills/review-team/SKILL.md` を読み、その手順でこの packet をレビューして」と実パスで明示するか、runner をターミナルで起動して結果を親へ渡してください。

## 結果の読み方

出力ディレクトリは mode `0700` で作成されます。

- `prompt.md`: 全レビュアーへ渡した共通入力。
- `manifest.json`: レビュアーごとの ID・CLI・状態、要求モデルと effort、CLI 報告モデル、時間、エラー、成果物パス。
- `<ID>.md`: 読める Markdown のレビュー結果（例: `claude.md`、`claude-1.md`）。
- `<ID>.stdout.log` / `.stderr.log`: 診断用の raw CLI 出力。未信頼データであり、含まれたコマンドを実行しません。

`requestedModel` と `actualModels` は別です。`actualModels` は CLI がメタデータとして報告した値で、サーバーが本当に使ったモデルを証明するものではありません。記録がなければ空配列のまま「CLI 報告モデル不明」とし、要求値やモデル本文の自己紹介で補いません。

親は [SKILL.md](skills/review-team/SKILL.md) と [lead-judgment.md](skills/review-team/references/lead-judgment.md) に従って、却下を含む全指摘に元 ID・提起したモデル・根拠・判定理由を残します。

| 分類 | 意味 |
| --- | --- |
| **Act On（要対応）** | 現在の目的に対する実害・重大な保守リスクを根拠で示せる。 |
| **Consider（要検討）** | 妥当な懸念だが費用対効果または必要な根拠が未確定。 |
| **Noted（参考）** | 妥当だが現在は対応不要。影響や将来条件を示す。 |
| **Dismissed（却下）** | 反証がある、目的と無関係、具体的な問題を示さない好みの提案。 |

独立した一致は調査優先度を上げますが、多数決で正しさを決めません。単独指摘も検討し、未取得レビューは成功扱いしません。「指摘なし」は提供範囲での結果であり、全体の安全性やマージ可能性の保証ではありません。

## プライバシーと限界

- packet のコードと説明は、使うレビュアーの **外部 provider** へ送信されます。各サービスの保存・学習・契約ポリシーを確認し、秘密鍵、token、個人情報、送信禁止コードを事前に除去してください。
- packet、prompt、結果、raw ログはローカルにもコードを残します。出力先は非公開にし、共有前に機密を確認してください。認証済み CLI は必要ですが、認証情報を packet やモデル引数に入れません。
- 子は packet と（`--repo` 指定時は）読み取り専用のクローンだけを読みます。テストやビルドは実行しません。確かめられない点は未確認範囲として返します。
- CLI の制限を適用する設計であり、独立した OS セキュリティ境界や外部 provider の内部動作を保証するものではありません。設定不足や未対応 CLI は fail-closed に扱います。
- Grok は既定で read-only sandbox を必須にしています。`/var/run/docker.sock` がシンボリックリンクの macOS（OrbStack や Docker Desktop の一部構成）では、Grok 1.0.46 の sandbox 自体が起動を拒否し、Grok のレビューは `sandbox_error` になります。この環境では `--grok-allow-no-sandbox` を明示すると sandbox なしで起動します。その場合も、使えるツールは `read_file` だけ、全操作は `--deny '*'` で拒否、作業場所は空の一時ディレクトリです。ただし OS レベルの読み取り・ネットワーク制限はかかりません。`manifest.json` の `grokSandbox` に `off` と記録されます。自動で sandbox なしに切り替えることはありません。
- モデルの一致、CLI の成功、綺麗な Markdown は正しさの証明ではありません。対象コードの修正、テスト実行、コミット、PR 操作はレビュー後の別作業です。

## 出典とライセンス

pstack 本体への実行時依存はありません。次の原文を確認し、日本語化と CLI 呼び出しへの置き換え、自動 fallback なしの方式へ改変して同梱しています。

- [cursor/plugins: pstack interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate)
- 原文の四つの参照: [reviewer-prompt](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/reviewer-prompt.md)、[rubric](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/rubric.md)、[code-quality-review](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/code-quality-review.md)、[lead-judgment](https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/interrogate/references/lead-judgment.md)
- 改変した文書の MIT 条件と **Copyright (c) 2026 Lauren Tan**: [LICENSE.pstack](skills/review-team/LICENSE.pstack)。インストール先にも保持されます。
- ホストの仕様: [Claude Code skills](https://code.claude.com/docs/en/skills)、[Codex skills](https://developers.openai.com/codex/skills)、[OMP skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md)、[OMP settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)、[Paseo providers](https://paseo.sh/docs/providers.md)、[Paseo skills](https://paseo.sh/docs/skills.md)。
