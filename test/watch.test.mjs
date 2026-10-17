import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const watcher = new URL('../skills/review-team/scripts/watch-pr.mjs', import.meta.url).pathname;
const prUrl = 'https://example.test/acme/widget/pull/7';

async function setup(extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-watch-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const pr = join(dir, 'pr.json');
  const diff = join(dir, 'pr.diff');
  const leadLog = join(dir, 'lead.log');
  // gh answers from files the test rewrites, so each tick sees the PR as the test sets it.
  await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "api graphql") cat "${pr}" ;;
  "pr diff") cat "${diff}" ;;
  *) exit 1 ;;
esac
`);
  // The fake lead posts by recording a new review of the current head, unless the test makes it fail.
  const lead = join(dir, 'fake-claude');
  await writeFile(lead, `#!/bin/sh
for last; do :; done
echo "$*" >> "${leadLog}"
[ -f "${join(dir, 'lead-fails')}" ] && exit 1
[ -f "${join(dir, 'lead-hangs')}" ] && sleep 60
# A push during the review: the lead moves the head and stops without posting.
if [ -f "${join(dir, 'lead-pushes')}" ]; then
  printf '{"data":{"resource":{"state":"OPEN","isDraft":false,"headRefOid":"%s"}}}' "$(cat "${join(dir, 'lead-pushes')}")" > "${pr}"
  exit 0
fi
[ -f "${join(dir, 'lead-removes')}" ] && "${process.execPath}" "${watcher}" remove "${prUrl}" > /dev/null
out="${dir}/out-$$"
mkdir "$out"
head=$(sed -n 's/.*"headRefOid":"\\([^"]*\\)".*/\\1/p' "${pr}")
printf '{"repository":{"commit":"%s","pr":{"url":"${prUrl}"}}}' "$head" > "$out/manifest.json"
cp "${diff}" "$out/reviewed.diff"
"${process.execPath}" "${watcher}" record --output "$out" > /dev/null
`);
  await chmod(join(bin, 'gh'), 0o755);
  await chmod(lead, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state'),
    REVIEW_TEAM_LEAD_CLI: lead, REVIEW_TEAM_LEAD_TIMEOUT: '1', REVIEW_TEAM_QUIET: '0', ...extraEnv };
  delete env.REVIEW_TEAM_DEPTH;
  const setPr = (fields) => writeFile(pr, JSON.stringify({ data: { resource: {
    state: 'OPEN', isDraft: false, headRefOid: 'aaa', ...fields,
  } } }));
  const cli = (...args) => execFileAsync(process.execPath, [watcher, ...args], { env });
  const stateFile = join(dir, 'state', 'review-team', 'watch', 'prs', 'example.test', 'acme', 'widget', '7.json');
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  // run is detached from tick, so wait until it has started and its lock is gone.
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      if (!await stat(`${stateFile}.lock`).catch(() => null)) return;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error('再レビューが終わりません');
  };
  const tick = async () => {
    const before = await state().catch(() => null);
    const { stdout } = await cli('tick');
    if (/: review$/m.test(stdout)) {
      for (let i = 0; i < 100 && (await state()).lastAttemptAt === before?.lastAttemptAt; i++) {
        await new Promise(done => setTimeout(done, 50));
      }
      await settle();
    }
    return stdout;
  };
  const register = async (head, extra = []) => {
    const out = await mkdtemp(join(dir, `first-${head}-`));
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: head, pr: { url: prUrl } } }));
    await writeFile(join(out, 'reviewed.diff'), await readFile(diff));
    return JSON.parse((await cli('record', '--output', out, ...extra)).stdout);
  };
  // A new head is only observed on the first tick; the next tick acts on it.
  const tickAfterQuiet = async () => {
    assert.match(await tick(), /: observe \(settling\)$/m);
    return tick();
  };
  return { tickAfterQuiet, dir, diff, pr, leadLog, setPr, cli, state, stateFile, tick, register };
}

test('recordはPRを12時間登録し、tickはLLMを起動せずにpushが無いPRを見送る', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'aaa' });
  const result = await t.register('aaa', ['--effort', 'max']);
  assert.equal(result.registered, true);
  assert.match(result.schedule.cron, /^\* \* \* \* \* .*XDG_STATE_HOME='[^']*\/state' .* tick /);
  const s = await t.state();
  assert.equal(s.effort, 'max');
  assert.equal(s.maxRereviews, 3);
  assert.equal(Date.parse(s.expiresAt) - Date.parse(s.registeredAt), 12 * 3600 * 1000);
  assert.match(await t.tick(), /skip \(reviewed\)/);
  assert.equal(await readFile(t.leadLog, 'utf8').catch(() => ''), '');
});

test('新しいheadは次のtickでも変わっていなければ再レビューし、差分が同じpushは見送る', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'aaa' });
  await t.register('aaa');

  await t.setPr({ headRefOid: 'bbb', isDraft: true });
  assert.match(await t.tick(), /skip \(draft\)/);

  await t.setPr({ headRefOid: 'bbb' });
  assert.match(await t.tickAfterQuiet(), /same-diff/);
  assert.equal((await t.state()).lastReviewedCommit, 'bbb');
  assert.equal((await t.state()).rereviews, 0);

  await writeFile(t.diff, 'diff-2\n');
  await t.setPr({ headRefOid: 'ccc' });
  assert.match(await t.tick(), /observe/);
  // Another push before the next tick restarts the quiet time.
  await t.setPr({ headRefOid: 'ddd' });
  assert.match(await t.tick(), /observe/);
  assert.match(await t.tick(), /: review$/m);
  const s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ddd');
  assert.equal(s.rereviews, 1);
  assert.equal(s.failures, 0);
  assert.match(await readFile(t.leadLog, 'utf8'), /^-p --effort xhigh --permission-mode auto \/review-team --comment --rereview 1\/3 https:\/\/example\.test\/acme\/widget\/pull\/7\n$/);
});

test('再レビューは登録時のレビューと同じレビュアーで起動する', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-a');
  const out = await mkdtemp(join(t.dir, 'first-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'aaa', pr: { url: prUrl } },
    reviewers: [{ cli: 'claude', requestedModel: 'claude-opus-5-5', requestedEffort: 'high' },
      { cli: 'grok', requestedModel: 'grok-4.7', requestedEffort: 'max' }] }));
  await writeFile(join(out, 'reviewed.diff'), 'diff-a');
  await t.cli('record', '--output', out);
  await t.setPr({ headRefOid: 'bbb' });
  await writeFile(t.diff, 'diff-b');
  await t.tickAfterQuiet();
  assert.match(await readFile(t.leadLog, 'utf8'),
    / --rereview 1\/3 --reviewer claude:claude-opus-5-5:high --reviewer grok:grok-4.7:max https:\/\/example\.test\/acme\/widget\/pull\/7\n$/);
});

test('レビュアーを記録していない以前のウォッチは、agyを含まない以前の既定で再レビューする', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-a');
  await t.register('aaa');
  const { reviewers, ...legacy } = await t.state();
  await writeFile(t.stateFile, JSON.stringify(legacy));
  await t.setPr({ headRefOid: 'bbb' });
  await writeFile(t.diff, 'diff-b');
  await t.tickAfterQuiet();
  assert.match(await readFile(t.leadLog, 'utf8'),
    / --rereview 1\/3 --reviewer claude:claude-opus-5-5:high --reviewer codex:gpt-6.1-sol:high --reviewer grok:grok-4.7-build-fast:high https:/);
});

test('再レビューは上限で止まり、マージでも止まる', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa', ['--max-rereviews', '2']);
  for (const head of ['b1', 'b2', 'b3']) {
    await writeFile(t.diff, `diff-${head}\n`);
    await t.setPr({ headRefOid: head });
    await t.tick();
    await t.tick();
  }
  const s = await t.state();
  assert.equal(s.rereviews, 2);
  assert.equal(s.stoppedReason, 'limit');
  assert.equal((await readFile(t.leadLog, 'utf8')).trim().split('\n').length, 2);

  const merged = await setup();
  await merged.setPr({ headRefOid: 'aaa' });
  await writeFile(merged.diff, 'diff\n');
  await merged.register('aaa');
  await merged.setPr({ state: 'MERGED', headRefOid: 'bbb' });
  assert.match(await merged.tick(), /stop \(merged\)/);
  assert.equal((await merged.state()).stoppedReason, 'merged');
  assert.equal(await merged.tick(), '');
});

test('投稿を記録しなかった再レビューは失敗として数え、2回続くと止まる。期限切れでも止まる', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-fails'), '');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  await t.tickAfterQuiet();
  assert.equal((await t.state()).failures, 1);
  await t.tick();
  assert.equal((await t.state()).failures, 2);
  assert.match(await t.tick(), /stop \(failed\)/);

  const expired = await setup();
  await expired.setPr({ headRefOid: 'aaa' });
  await writeFile(expired.diff, 'diff\n');
  await expired.register('aaa', ['--ttl-hours', '0']);
  assert.match(await expired.tick(), /stop \(expired\)/);
  // Registering again after a stop starts a fresh watch.
  assert.equal((await expired.register('aaa')).registered, true);
  assert.equal((await expired.state()).stoppedReason, null);
});

test('止まらない再レビューは制限時間で止めて失敗に数え、期限切れはGitHubに届かなくても止まる', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-hangs'), '');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  await t.tickAfterQuiet();
  const s = await t.state();
  assert.equal(s.failures, 1);
  assert.equal(s.lastExitCode, 'SIGTERM');

  const offline = await setup();
  await offline.setPr({ headRefOid: 'aaa' });
  await writeFile(offline.diff, 'diff\n');
  await offline.register('aaa', ['--ttl-hours', '0']);
  await writeFile(offline.pr, 'not json');
  assert.match(await offline.tick(), /stop \(expired\)/);
});

test('再レビュー中に解除したウォッチは、その再レビューの記録で戻らない', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-removes'), '');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  await t.tick();
  const { stdout } = await t.cli('tick');
  assert.match(stdout, /: review$/m);
  for (let i = 0; i < 100 && await stat(t.stateFile).catch(() => null); i++) await new Promise(done => setTimeout(done, 50));
  for (let i = 0; i < 100 && await stat(`${t.stateFile}.lock`).catch(() => null); i++) await new Promise(done => setTimeout(done, 50));
  assert.equal(await stat(t.stateFile).catch(() => null), null);
});

test('再レビュー中にheadが進んだ回は失敗にも回数にも数えず、新しいheadを次のtickで再レビューする', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-pushes'), 'ccc');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  assert.match(await t.tickAfterQuiet(), /: review$/m);
  let s = await t.state();
  assert.equal(s.failures, 0);
  assert.equal(s.rereviews, 0);
  assert.equal(s.supersededRuns, 1);
  assert.equal(s.pendingHead, 'ccc');
  assert.equal(s.lastReviewedCommit, 'aaa');

  // The head the lead saw arrive is already being watched, so the next tick reviews it.
  await rm(join(t.dir, 'lead-pushes'));
  assert.match(await t.tick(), /: review$/m);
  s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ccc');
  assert.equal(s.rereviews, 1);
  assert.equal(s.supersededRuns, 0);
  assert.match(await readFile(t.leadLog, 'utf8'), / --rereview 1\/3 .*\n.* --rereview 1\/3 /);
});

test('追い越しが続くと静穏時間を延ばし、4倍で止める', async () => {
  const t = await setup({ REVIEW_TEAM_QUIET: '1' });
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  const since = seconds => new Date(Date.now() - seconds * 1000).toISOString();
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), supersededRuns: 1, pendingHead: 'bbb', pendingSince: since(1.5) }));
  assert.match(await t.tick(), /skip \(settling\)/);
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), supersededRuns: 3, pendingSince: since(3) }));
  assert.match(await t.tick(), /skip \(settling\)/);
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), pendingSince: since(5) }));
  assert.match(await t.tick(), /: review$/m);
});

test('tickのあと再レビューを始める前にheadが進んでいれば、レビューを起動せずに次のtickへ回す', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), pendingHead: 'bbb', pendingSince: new Date().toISOString() }));
  await t.setPr({ headRefOid: 'ccc' });
  await t.cli('run', t.stateFile);
  const s = await t.state();
  assert.equal(await readFile(t.leadLog, 'utf8').catch(() => ''), '');
  assert.equal(s.rereviews, 0);
  assert.equal(s.failures, 0);
  assert.equal(s.pendingHead, 'ccc');
  // No review ran, so the quiet time stays at the base.
  assert.equal(s.supersededRuns, 0);
});

test('追い越しのあと差分が同じpushで落ち着いたら、静穏時間を元に戻す', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), supersededRuns: 2 }));
  await t.setPr({ headRefOid: 'bbb' });
  assert.match(await t.tickAfterQuiet(), /same-diff/);
  assert.equal((await t.state()).supersededRuns, 0);
});

test('deferはレビュー済みのcommitなしで登録し、tickが最初の投稿をする', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-0\n');
  const out = await mkdtemp(join(t.dir, 'deferred-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'aaa', pr: { url: prUrl } } }));
  const result = JSON.parse((await t.cli('defer', '--output', out, '--effort', 'high')).stdout);
  assert.equal(result.registered, true);
  assert.equal(result.deferred, true);
  assert.equal((await t.state()).lastReviewedCommit, null);
  await t.setPr({ headRefOid: 'ccc' });
  assert.match(await t.tickAfterQuiet(), /: review$/m);
  const s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ccc');
  assert.equal(s.rereviews, 1);
  assert.match(await readFile(t.leadLog, 'utf8'), /^-p --effort high .* --rereview 1\/3 /);
});
