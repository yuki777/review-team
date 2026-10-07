# Changelog

## [v0.1.7](https://github.com/yuki777/review-team/compare/v0.1.6...v0.1.7) - 2026-10-07

- feat(review-team): 既定のレビュアーを Opus 5.5 と GPT 6.1 Sol にする by @yuki777 in https://github.com/yuki777/review-team/pull/33

## [v0.1.6](https://github.com/yuki777/review-team/compare/v0.1.5...v0.1.6) - 2026-10-07

- fix(review-team): レビュアーの本文を reviewer-<ID>.md に書き、CLAUDE.md と名前が重ならないようにする by @yuki777 in https://github.com/yuki777/review-team/pull/30

## [v0.1.5](https://github.com/yuki777/review-team/compare/v0.1.4...v0.1.5) - 2026-10-06

- docs(review-team): PR への投稿の総評から「未確認の範囲」の行を消す by @yuki777 in https://github.com/yuki777/review-team/pull/28
- test(review-team): reviewed.diff の残りの契約をテストする by @yuki777 in https://github.com/yuki777/review-team/pull/27

## [v0.1.4](https://github.com/yuki777/review-team/compare/v0.1.3...v0.1.4) - 2026-10-06

- fix(review-team): PR への投稿は常に COMMENT にし、event を選ぶ分岐をなくす by @yuki777 in https://github.com/yuki777/review-team/pull/23
- feat(review-team): 参照文書4つを upstream の英語の原文に戻す by @yuki777 in https://github.com/yuki777/review-team/pull/25
- feat(review-team): リード判定の統合と出力の形式を upstream の interrogate に合わせる by @yuki777 in https://github.com/yuki777/review-team/pull/26

## [v0.1.3](https://github.com/yuki777/review-team/compare/v0.1.2...v0.1.3) - 2026-10-06

- feat(review-team): --comment でレビュー結果を承認を待たずに PR へ投稿する by @yuki777 in https://github.com/yuki777/review-team/pull/18
- feat(review-team): 既定のレビュアーを Claude と Codex にし、Grok をオプションにする by @yuki777 in https://github.com/yuki777/review-team/pull/22
- fix(review-team): Grok が隔離環境に書き出す同梱 skill を ignore し、検査失敗の理由を示す by @yuki777 in https://github.com/yuki777/review-team/pull/19

## [v0.1.2](https://github.com/yuki777/review-team/compare/v0.1.1...v0.1.2) - 2026-10-05

- fix(review-team): 投稿手順の循環を解き、行の位置を一覧から選ばせる by @yuki777 in https://github.com/yuki777/review-team/pull/16

## [v0.1.1](https://github.com/yuki777/review-team/compare/v0.1.0...v0.1.1) - 2026-10-05

- feat(review-team): リードの判定を GitHub PR レビューとして投稿する by @yuki777 in https://github.com/yuki777/review-team/pull/7
- feat(review-team): review-team の版を記録して PR の総評に出し、tagpr でリリースする by @yuki777 in https://github.com/yuki777/review-team/pull/8

## [v0.1.0](https://github.com/yuki777/review-team/commits/v0.1.0) - 2026-10-03

- feat(review-team): 複数のCLI・モデルで独立レビューするスキルを追加 by @yuki777 in https://github.com/yuki777/review-team/pull/3
- docs: インストールを npx skills add にし、READMEを使い方中心に簡潔化 by @yuki777 in https://github.com/yuki777/review-team/pull/4
- fix(review-team): 実運用の確認で見つかった不具合を直す by @yuki777 in https://github.com/yuki777/review-team/pull/5
- feat(review-team): --pr でPRのリポジトリをキャッシュしてレビューする by @yuki777 in https://github.com/yuki777/review-team/pull/6
