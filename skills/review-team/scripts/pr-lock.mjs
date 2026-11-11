#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireLock, fetchPr, prLockPath, readReviewed, releaseLock, reviewedPath, writeState } from './watch-pr.mjs';

const script = fileURLToPath(import.meta.url);
const help = `review-team pr-lock: rt がレビューを始める前に、同じPRのレビューを止めるかを決めます。

node pr-lock.mjs acquire [--force] --pid <PID> <PR-URL>
    GitHub で PR の head を確かめ、PR のロックを PID の名前で取る。取れたら GitHub の表記の PR の URL を出す。
    （リードが記録する URL と同じ表記にして、ロックとレビュー済みの記録を同じ場所に置く）
    PID のプロセスが終わるか、そのレビューの投稿が record・defer で記録されるまで、ほかのレビューは始まらない。
    終了ステータス: 0 = レビューを始める。3 = 見送る（理由を1行出す）。2 = GitHub に問い合わせられないなどの失敗。
見送る条件: 同じPRのレビュー（rt か watch の再レビュー）が実行中。
            head がレビュー済み（投稿を記録した commit と同じ）。--force を付けると見送らない。
`;

const skip = message => { console.log(message); process.exitCode = 3; };

// Asks GitHub before taking the lock, so a failure leaves nothing behind.
// Each start is counted before the review runs, so a review killed midway still counts as an attempt.
async function acquire(values, given) {
  const pid = Number(values.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('--pidにはロックを持つプロセスのpidを指定してください。');
  const { url, head } = await fetchPr(given);
  if (!await acquireLock(prLockPath(url), pid)) return skip(`同じPRのレビューが実行中なので見送ります: ${url}`);
  const reviewed = await readReviewed(url);
  if (!values.force && reviewed.completedHead === head) {
    // Checked under the lock, so a review that has just posted this head is seen. The lock is given back at once.
    await releaseLock(prLockPath(url), pid);
    return skip(`head ${head.slice(0, 12)} はレビュー済みなので見送ります（やり直すには --force）: ${url}`);
  }
  const attempts = reviewed.attemptHead === head ? (reviewed.attempts ?? 0) + 1 : 1;
  await writeState(reviewedPath(url), { ...reviewed, attemptHead: head, attempts });
  console.log(url);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    force: { type: 'boolean' }, pid: { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, url] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (command === 'acquire') return acquire(values, url);
  throw new Error(`未対応のコマンドです: ${command}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === script) {
  await main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
