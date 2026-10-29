# Changelog

## [v0.1.34](https://github.com/yuki777/review-team/compare/v0.1.33...v0.1.34) - 2026-10-29

- スキルのディレクトリがシンボリックリンクでも scan-prs.mjs と watch-pr.mjs が動くようにする by @yuki777 in https://github.com/yuki777/review-team/pull/112

## [v0.1.33](https://github.com/yuki777/review-team/compare/v0.1.32...v0.1.33) - 2026-10-29

- scan の最後に終了の時刻とレビュー・見送りの件数を出す by @yuki777 in https://github.com/yuki777/review-team/pull/110

## [v0.1.32](https://github.com/yuki777/review-team/compare/v0.1.31...v0.1.32) - 2026-10-29

- README の scan-prs の例を effort 付きのチームにする by @yuki777 in https://github.com/yuki777/review-team/pull/108

## [v0.1.31](https://github.com/yuki777/review-team/compare/v0.1.30...v0.1.31) - 2026-10-29

- ウォッチが解除・停止されたら、登録した対話のセッションで知らせる by @yuki777 in https://github.com/yuki777/review-team/pull/106

## [v0.1.30](https://github.com/yuki777/review-team/compare/v0.1.29...v0.1.30) - 2026-10-29

- review-team コマンドでメンバーごとに effort を指定できるようにする by @yuki777 in https://github.com/yuki777/review-team/pull/103

## [v0.1.29](https://github.com/yuki777/review-team/compare/v0.1.28...v0.1.29) - 2026-10-28

- /review-team の補完に引数ヒントを出す by @yuki777 in https://github.com/yuki777/review-team/pull/100

## [v0.1.28](https://github.com/yuki777/review-team/compare/v0.1.27...v0.1.28) - 2026-10-28

- 自分宛てのレビュー依頼が来た PR を毎時見つけて自動でレビューする by @yuki777 in https://github.com/yuki777/review-team/pull/97

## [v0.1.27](https://github.com/yuki777/review-team/compare/v0.1.26...v0.1.27) - 2026-10-28

- --act-on-only で PR には Act On の指摘だけを投稿する by @yuki777 in https://github.com/yuki777/review-team/pull/94

## [v0.1.26](https://github.com/yuki777/review-team/compare/v0.1.25...v0.1.26) - 2026-10-28

- 重大な不具合やセキュリティでないレアケースの指摘は分類を1つ下げる by @yuki777 in https://github.com/yuki777/review-team/pull/91

## [v0.1.25](https://github.com/yuki777/review-team/compare/v0.1.24...v0.1.25) - 2026-10-27

- 指摘を検出したモデルを Model の行で表示する by @yuki777 in https://github.com/yuki777/review-team/pull/88

## [v0.1.24](https://github.com/yuki777/review-team/compare/v0.1.23...v0.1.24) - 2026-10-23

- ウォッチをマージ・期限切れ・上限で自動で解除し、上限は最後の再レビューの直後に止める by @yuki777 in https://github.com/yuki777/review-team/pull/86

## [v0.1.23](https://github.com/yuki777/review-team/compare/v0.1.22...v0.1.23) - 2026-10-19

- review-team コマンドで版を表示する（USAGE と --version） by @yuki777 in https://github.com/yuki777/review-team/pull/83

## [v0.1.22](https://github.com/yuki777/review-team/compare/v0.1.21...v0.1.22) - 2026-10-19

- ウォッチの期限の既定を6時間にし、自動再レビューで外の状態を待たない決まりを足す by @yuki777 in https://github.com/yuki777/review-team/pull/80

## [v0.1.21](https://github.com/yuki777/review-team/compare/v0.1.20...v0.1.21) - 2026-10-19

- ウォッチの再レビュー中も head を見張り、進んだらリードを止める by @yuki777 in https://github.com/yuki777/review-team/pull/76

## [v0.1.20](https://github.com/yuki777/review-team/compare/v0.1.19...v0.1.20) - 2026-10-19

- runner: refs/pull/N/head が PR の head とずれていたら head のコミットを直接取る by @yuki777 in https://github.com/yuki777/review-team/pull/75

## [v0.1.19](https://github.com/yuki777/review-team/compare/v0.1.18...v0.1.19) - 2026-10-19

- PR に投稿する指摘に、検出したモデルを HTML コメントで残す by @yuki777 in https://github.com/yuki777/review-team/pull/70

## [v0.1.18](https://github.com/yuki777/review-team/compare/v0.1.17...v0.1.18) - 2026-10-19

- レビュアーの一部が失敗しても、2人以上成功すれば確かめずに判定へ進む by @yuki777 in https://github.com/yuki777/review-team/pull/67

## [v0.1.17](https://github.com/yuki777/review-team/compare/v0.1.16...v0.1.17) - 2026-10-19

- feat(review-team): ターミナルから起動するコマンド review-team を同梱する by @yuki777 in https://github.com/yuki777/review-team/pull/64

## [v0.1.16](https://github.com/yuki777/review-team/compare/v0.1.15...v0.1.16) - 2026-10-19

- feat(review-team): 自動再レビューの上限の既定を5回にする by @yuki777 in https://github.com/yuki777/review-team/pull/61

## [v0.1.15](https://github.com/yuki777/review-team/compare/v0.1.14...v0.1.15) - 2026-10-17

- feat(review-team): head が進んでも止まらずに新しい head の再レビューへつなぐ by @yuki777 in https://github.com/yuki777/review-team/pull/58

## [v0.1.14](https://github.com/yuki777/review-team/compare/v0.1.13...v0.1.14) - 2026-10-16

- docs(review-team): 再レビューで直ったと確かめた前回の指摘のスレッドを resolve する by @yuki777 in https://github.com/yuki777/review-team/pull/55

## [v0.1.13](https://github.com/yuki777/review-team/compare/v0.1.12...v0.1.13) - 2026-10-16

- 既定のレビュアーに agy:gemini-4-argon-high:high を追加する by @yuki777 in https://github.com/yuki777/review-team/pull/52

## [v0.1.12](https://github.com/yuki777/review-team/compare/v0.1.11...v0.1.12) - 2026-10-14

- docs(review-team): リードはキャッシュのコミットからコードを読む by @yuki777 in https://github.com/yuki777/review-team/pull/49

## [v0.1.11](https://github.com/yuki777/review-team/compare/v0.1.10...v0.1.11) - 2026-10-14

- docs(review-team): PR への投稿の総評に「確認した点」と、あれば「一次資料」を書く by @yuki777 in https://github.com/yuki777/review-team/pull/46

## [v0.1.10](https://github.com/yuki777/review-team/compare/v0.1.9...v0.1.10) - 2026-10-14

- runner: 進捗を stderr に書き、PR キャッシュのクローンを並行実行に耐えるようにする by @yuki777 in https://github.com/yuki777/review-team/pull/41
- feat(review-team): --watch で投稿した PR を見回り、新しい push を自動で再レビューする by @yuki777 in https://github.com/yuki777/review-team/pull/44

## [v0.1.9](https://github.com/yuki777/review-team/compare/v0.1.8...v0.1.9) - 2026-10-09

- feat(review-team): Grok を既定のレビュアーに戻す by @yuki777 in https://github.com/yuki777/review-team/pull/39

## [v0.1.8](https://github.com/yuki777/review-team/compare/v0.1.7...v0.1.8) - 2026-10-07

- feat(review-team): Antigravity CLI（agy）をレビュアーに追加し、Grok をふだんの設定のまま起動する by @yuki777 in https://github.com/yuki777/review-team/pull/36

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
