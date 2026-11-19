import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  // With gh-fails-after-stop, GitHub stops answering once run() has decided to stop the lead.
  const posting = join(dir, 'state', 'review-team', 'watch', 'prs', 'example.test', 'acme', 'widget', '7.json.posting');
  await writeFile(join(bin, 'gh'), `#!/bin/sh
[ -f "${join(dir, 'gh-fails-after-stop')}" ] && grep -qx watch "${posting}" 2>/dev/null && exit 1
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
# The lead marks that it started posting, as github-post.md section 4 tells it to.
[ -f "${join(dir, 'lead-posts')}" ] && { ( set -C; echo lead > "$REVIEW_TEAM_WATCH_POSTING" ) 2>/dev/null || grep -qx lead "$REVIEW_TEAM_WATCH_POSTING"; }
# A push during the review: the lead moves the head and stops without posting.
[ -f "${join(dir, 'lead-pushes')}" ] && printf '{"data":{"resource":{"state":"OPEN","isDraft":false,"headRefOid":"%s"}}}' "$(cat "${join(dir, 'lead-pushes')}")" > "${pr}"
# lead-hangs holds how many seconds the lead takes; empty means it hangs.
[ -f "${join(dir, 'lead-hangs')}" ] && { s=$(cat "${join(dir, 'lead-hangs')}"); sleep "\${s:-60}"; }
[ -f "${join(dir, 'lead-pushes')}" ] && exit 0
[ -f "${join(dir, 'lead-removes')}" ] && "${process.execPath}" "${watcher}" remove "${prUrl}" > /dev/null
out="${dir}/out-$$"
mkdir "$out"
head=$(sed -n 's/.*"headRefOid":"\\([^"]*\\)".*/\\1/p' "${pr}")
printf '{"repository":{"commit":"%s","pr":{"url":"${prUrl}"}}}' "$head" > "$out/manifest.json"
cp "${diff}" "$out/reviewed.diff"
"${process.execPath}" "${watcher}" record --output "$out" --act-on 1 > /dev/null
`);
  // brew names a prefix whose app exists only once a test installs it; open logs its arguments, one call per line.
  const openLog = join(dir, 'open.log');
  await writeFile(join(bin, 'brew'), `#!/bin/sh\necho "${join(dir, 'brew')}"\n`);
  await writeFile(join(bin, 'open'), `#!/bin/sh\nprintf '%s|' "$@" >> "${openLog}"\necho >> "${openLog}"\n`);
  for (const name of ['gh', 'brew', 'open']) await chmod(join(bin, name), 0o755);
  await chmod(lead, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config'),
    REVIEW_TEAM_LEAD_CLI: lead, REVIEW_TEAM_LEAD_TIMEOUT: '1', REVIEW_TEAM_QUIET: '0', ...extraEnv };
  delete env.REVIEW_TEAM_DEPTH;
  // One answer serves both the watch query and the notify query, which reads the fields after headRefOid.
  const setPr = (fields) => writeFile(pr, JSON.stringify({ data: { resource: {
    state: 'OPEN', isDraft: false, headRefOid: 'aaa', mergeable: 'MERGEABLE', viewerDidAuthor: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewThreads: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, ...fields,
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
    if (/ review$/m.test(stdout)) {
      for (let i = 0; i < 100 && (await state()).lastAttemptAt === before?.lastAttemptAt; i++) {
        await new Promise(done => setTimeout(done, 50));
      }
      await settle();
    }
    return stdout;
  };
  const register = async (head, extra = [], actOn = '1') => {
    const out = await mkdtemp(join(dir, `first-${head}-`));
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: head, pr: { url: prUrl } } }));
    await writeFile(join(out, 'reviewed.diff'), await readFile(diff));
    return JSON.parse((await cli('record', '--output', out, '--act-on', actOn, ...extra)).stdout);
  };
  // A new head is only observed on the first tick; the next tick acts on it.
  const tickAfterQuiet = async () => {
    assert.match(await tick(), / observe \(settling\)$/m);
    return tick();
  };
  const app = join(dir, 'brew', 'terminal-notifier.app');
  const installApp = () => mkdir(app, { recursive: true });
  const opens = async () => (await readFile(openLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const notifyFile = `${stateFile}.notify`;
  const notifyState = async () => JSON.parse(await readFile(notifyFile, 'utf8'));
  // Moves a time in the notify record into the past, as if that many hours had gone by.
  const age = async (field, hours) => writeFile(notifyFile, JSON.stringify({ ...await notifyState(),
    [field]: new Date(Date.now() - hours * 3600 * 1000).toISOString() }));
  return { tickAfterQuiet, env, dir, diff, pr, leadLog, setPr, cli, state, stateFile, tick, register,
    app, installApp, opens, notifyFile, notifyState, age };
}

test('recordはPRを12時間登録し、tickはLLMを起動せずにpushが無いPRを見送る', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'aaa' });
  const result = await t.register('aaa', ['--effort', 'max']);
  assert.equal(result.registered, true);
  assert.match(result.schedule.cron, /^\* \* \* \* \* .*XDG_STATE_HOME='[^']*\/state' .* tick /);
  // Scheduled jobs get the config directory too: a scheduled scan reads the user's rt.json through rt.
  assert.match(result.schedule.cron, / XDG_CONFIG_HOME='[^']*\/config' /);
  const s = await t.state();
  assert.equal(s.effort, 'max');
  assert.equal(s.maxRereviews, 5);
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
  assert.match(await t.tick(), / review$/m);
  const s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ddd');
  assert.equal(s.rereviews, 1);
  assert.equal(s.failures, 0);
  assert.match(await readFile(t.leadLog, 'utf8'), /^-p --model claude-opus-5-5 --effort xhigh --permission-mode auto \/review-team --comment --rereview 1\/5 https:\/\/example\.test\/acme\/widget\/pull\/7\n$/);
});

test('再レビューは登録時のレビューと同じレビュアーで起動する', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-a');
  const out = await mkdtemp(join(t.dir, 'first-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'aaa', pr: { url: prUrl } },
    reviewers: [{ cli: 'claude', requestedModel: 'claude-opus-5-5', requestedEffort: 'high' },
      { cli: 'codex', requestedModel: 'gpt-6-astra', requestedEffort: 'max' }] }));
  await writeFile(join(out, 'reviewed.diff'), 'diff-a');
  await t.cli('record', '--output', out, '--act-on', '1');
  await t.setPr({ headRefOid: 'bbb' });
  await writeFile(t.diff, 'diff-b');
  await t.tickAfterQuiet();
  assert.match(await readFile(t.leadLog, 'utf8'),
    / --rereview 1\/5 --reviewer claude:claude-opus-5-5:high --reviewer codex:gpt-6-astra:max https:\/\/example\.test\/acme\/widget\/pull\/7\n$/);
});

test('--with-considerで登録したウォッチは、記録し直しても再レビューに--with-considerを付ける', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-a');
  assert.equal((await t.register('aaa', ['--with-consider'])).withConsider, true);
  // A re-review records without the flag; the registered value stays.
  assert.equal((await t.register('aaa')).withConsider, true);
  await t.setPr({ headRefOid: 'bbb' });
  await writeFile(t.diff, 'diff-b');
  await t.tickAfterQuiet();
  assert.match(await readFile(t.leadLog, 'utf8'), / \/review-team --comment --with-consider --rereview 1\/5 https:/);
});

test('レビュアーを記録していない以前のウォッチは、既定のレビュアーで再レビューする', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-a');
  await t.register('aaa');
  const { reviewers, ...legacy } = await t.state();
  await writeFile(t.stateFile, JSON.stringify(legacy));
  await t.setPr({ headRefOid: 'bbb' });
  await writeFile(t.diff, 'diff-b');
  await t.tickAfterQuiet();
  assert.match(await readFile(t.leadLog, 'utf8'), / --rereview 1\/5 https:/);
});

test('上限の回を投稿した次のtickで、GitHubに問い合わせずに解除し、マージでも解除する', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa', ['--max-rereviews', '2']);
  for (const head of ['b1', 'b2']) {
    await writeFile(t.diff, `diff-${head}\n`);
    await t.setPr({ headRefOid: head });
    assert.match(await t.tickAfterQuiet(), / review$/m);
  }
  assert.equal((await t.state()).rereviews, 2);
  // While the last re-review still runs, its watch stays so the lead can record the post.
  await writeFile(`${t.stateFile}.lock`, String(process.pid));
  assert.match(await t.tick(), /skip \(running\)/);
  await rm(`${t.stateFile}.lock`);
  // No new push is needed, and GitHub is not asked.
  await writeFile(t.pr, 'not json');
  assert.match(await t.tick(), /remove \(limit\)/);
  assert.equal(await stat(t.stateFile).catch(() => null), null);
  assert.equal((await readFile(t.leadLog, 'utf8')).trim().split('\n').length, 2);

  const merged = await setup();
  await merged.setPr({ headRefOid: 'aaa' });
  await writeFile(merged.diff, 'diff\n');
  await merged.register('aaa');
  await merged.setPr({ state: 'MERGED', headRefOid: 'bbb' });
  assert.match(await merged.tick(), /remove \(merged\)/);
  assert.equal(await stat(merged.stateFile).catch(() => null), null);
  assert.equal(await merged.tick(), '');
});

test('以前の版で止まったウォッチは、失敗で止まったもの以外を解除する', async () => {
  const t = await setup();
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff\n');
  await t.register('aaa');
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), stoppedReason: 'expired' }));
  assert.match(await t.tick(), /remove \(expired\)/);
  assert.equal(await stat(t.stateFile).catch(() => null), null);
});

test('投稿を記録しなかった再レビューは失敗として数え、2回続くと停止して残る。期限切れは解除する', async () => {
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
  assert.equal((await t.state()).stoppedReason, 'failed');
  assert.equal(await t.tick(), '');
  assert.match((await t.cli('list')).stdout, /停止\(failed\)/);
  // Registering again after a stop starts a fresh watch.
  assert.equal((await t.register('bbb')).registered, true);
  assert.equal((await t.state()).stoppedReason, null);

  const expired = await setup();
  await expired.setPr({ headRefOid: 'aaa' });
  await writeFile(expired.diff, 'diff\n');
  await expired.register('aaa', ['--ttl-hours', '0']);
  assert.match(await expired.tick(), /remove \(expired\)/);
  assert.equal(await stat(expired.stateFile).catch(() => null), null);
  assert.equal((await expired.cli('list')).stdout, '');
});

test('止まらない再レビューは制限時間で止めて失敗に数え、期限切れはGitHubに届かなくても解除する', async () => {
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
  assert.match(await offline.tick(), /remove \(expired\)/);
  assert.equal(await stat(offline.stateFile).catch(() => null), null);
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
  assert.match(stdout, / review$/m);
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
  assert.match(await t.tickAfterQuiet(), / review$/m);
  let s = await t.state();
  assert.equal(s.failures, 0);
  assert.equal(s.rereviews, 0);
  assert.equal(s.supersededRuns, 1);
  assert.equal(s.pendingHead, 'ccc');
  assert.equal(s.lastReviewedCommit, 'aaa');

  // The head the lead saw arrive is already being watched, so the next tick reviews it.
  await rm(join(t.dir, 'lead-pushes'));
  assert.match(await t.tick(), / review$/m);
  s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ccc');
  assert.equal(s.rereviews, 1);
  assert.equal(s.supersededRuns, 0);
  assert.match(await readFile(t.leadLog, 'utf8'), / --rereview 1\/5 .*\n.* --rereview 1\/5 /);
});

test('再レビュー中にheadが進めば、投稿を始める前ならリードを止めて追い越しとして数える', async () => {
  const t = await setup({ REVIEW_TEAM_LEAD_TIMEOUT: '30', REVIEW_TEAM_HEAD_POLL: '0.2' });
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-pushes'), 'ccc');
  await writeFile(join(t.dir, 'lead-hangs'), '');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  const started = Date.now();
  assert.match(await t.tickAfterQuiet(), / review$/m);
  assert.ok(Date.now() - started < 10000);
  const s = await t.state();
  assert.equal(s.lastExitCode, 'SIGTERM');
  assert.equal(s.failures, 0);
  assert.equal(s.rereviews, 0);
  assert.equal(s.supersededRuns, 1);
  assert.equal(s.pendingHead, 'ccc');
});

test('headが進んで止めたあとGitHubに届かなくても、追い越しとして数える', async () => {
  const t = await setup({ REVIEW_TEAM_LEAD_TIMEOUT: '30', REVIEW_TEAM_HEAD_POLL: '0.2' });
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-pushes'), 'ccc');
  await writeFile(join(t.dir, 'lead-hangs'), '');
  await writeFile(t.diff, 'diff-1\n');
  await writeFile(join(t.dir, 'gh-fails-after-stop'), '');
  await t.setPr({ headRefOid: 'bbb' });
  assert.match(await t.tickAfterQuiet(), / review$/m);
  const s = await t.state();
  assert.equal(s.lastExitCode, 'SIGTERM');
  assert.equal(s.failures, 0);
  assert.equal(s.rereviews, 0);
  assert.equal(s.pendingHead, 'ccc');
});

test('投稿を始めたリードは、headが進んでも止めない', async () => {
  const t = await setup({ REVIEW_TEAM_LEAD_TIMEOUT: '30', REVIEW_TEAM_HEAD_POLL: '0.2' });
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-posts'), '');
  await writeFile(join(t.dir, 'lead-pushes'), 'ccc');
  await writeFile(join(t.dir, 'lead-hangs'), '1');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  await t.tickAfterQuiet();
  const s = await t.state();
  assert.equal(s.lastExitCode, 0);
  // The lead found the push itself and did not post, so the run is still overtaken, not failed.
  assert.equal(s.failures, 0);
  assert.equal(s.supersededRuns, 1);
  assert.equal(await stat(`${t.stateFile}.posting`).catch(() => null), null);
});

test('headが進まなければ、再レビュー中に見張ってもリードを止めない', async () => {
  const t = await setup({ REVIEW_TEAM_LEAD_TIMEOUT: '30', REVIEW_TEAM_HEAD_POLL: '0.2' });
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff-0\n');
  await t.register('aaa');
  await writeFile(join(t.dir, 'lead-hangs'), '1');
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'bbb' });
  await t.tickAfterQuiet();
  const s = await t.state();
  assert.equal(s.lastExitCode, 0);
  assert.equal(s.lastReviewedCommit, 'bbb');
  assert.equal(s.rereviews, 1);
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
  assert.match(await t.tick(), / review$/m);
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
  const result = JSON.parse((await t.cli('defer', '--output', out, '--effort', 'high', '--max-rereviews', '0')).stdout);
  assert.equal(result.registered, true);
  assert.equal(result.deferred, true);
  assert.equal((await t.state()).lastReviewedCommit, null);
  await t.setPr({ headRefOid: 'ccc' });
  assert.match(await t.tickAfterQuiet(), / review$/m);
  const s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ccc');
  // The first post does not use the re-review allowance, even when it is 0.
  assert.equal(s.rereviews, 0);
  assert.match(await readFile(t.leadLog, 'utf8'), /^-p --model claude-opus-5-5 --effort high .* --rereview 0\/0 /);
});

test('waitはtickかremoveが解除したときに理由を出して終わり、解除のあとに起動しても理由を出す', async () => {
  const t = await setup();
  const wait = () => execFileAsync(process.execPath, [watcher, 'wait', prUrl],
    { env: { ...process.env, PATH: `${t.dir}/bin:${process.env.PATH}`, XDG_STATE_HOME: join(t.dir, 'state'), REVIEW_TEAM_WAIT_POLL: '0.05' } })
    .then(({ stdout }) => JSON.parse(stdout));
  await writeFile(t.diff, 'diff\n');
  const cases = [
    ['merged', () => t.setPr({ state: 'MERGED' }).then(t.tick)],
    ['closed', () => t.setPr({ state: 'CLOSED' }).then(t.tick)],
    ['expired', () => t.tick(), ['--ttl-hours', '0']],
    ['limit', () => t.tick(), ['--max-rereviews', '0']],
    ['removed', () => t.cli('remove', prUrl)],
  ];
  for (const [reason, end, extra = []] of cases) {
    await t.setPr({ headRefOid: 'aaa' });
    const registered = await t.register('aaa', extra);
    assert.equal(registered.registered, true);
    const waiting = wait();
    await end();
    const result = await waiting;
    assert.equal(result.reason, reason);
    assert.equal(result.pr, prUrl);
    assert.equal(result.expiresAt, registered.expiresAt);
    assert.equal(result.maxRereviews, registered.maxRereviews);
    // A wait started again after the removal reports the same reason at once.
    assert.equal((await wait()).reason, reason);
  }
  // Registering the PR again clears the old reason, so a wait sees the new watch.
  await t.setPr({ headRefOid: 'aaa' });
  await t.register('aaa');
  await t.cli('remove', prUrl);
  await t.register('aaa');
  assert.equal(await stat(`${t.stateFile}.removed`).catch(() => null), null);
  await t.setPr({ state: 'MERGED' });
  const waiting = wait();
  await t.tick();
  assert.equal((await waiting).reason, 'merged');
});

test('waitは失敗で停止したときにも終わり、未登録のPRではすぐ失敗する', async () => {
  const t = await setup();
  const wait = () => execFileAsync(process.execPath, [watcher, 'wait', prUrl],
    { env: { ...process.env, XDG_STATE_HOME: join(t.dir, 'state'), REVIEW_TEAM_WAIT_POLL: '0.05' } });
  await assert.rejects(wait(), error => error.code === 2 && /ウォッチに登録されていません/.test(error.stderr));
  await t.setPr({ headRefOid: 'aaa' });
  await writeFile(t.diff, 'diff\n');
  await t.register('aaa');
  const waiting = wait();
  await writeFile(t.stateFile, JSON.stringify({ ...await t.state(), failures: 2 }));
  assert.match(await t.tick(), /stop \(failed\)/);
  assert.equal(JSON.parse((await waiting).stdout).reason, 'failed');
  assert.match((await t.cli('list')).stdout, /停止\(failed\)/);
});

test('死んだpidのロックを同時に回収しても、取れるのは1つだけで、残った回収の印は1分で無視する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-lock-'));
  const lock = join(dir, 'pr.lock');
  const dead = spawn('true');
  await new Promise(done => dead.on('exit', done));
  await writeFile(lock, String(dead.pid));
  // A reclaim left by a process killed midway, two minutes ago.
  await writeFile(`${lock}.reclaim-${dead.pid}`, '1');
  const old = new Date(Date.now() - 120000);
  await utimes(`${lock}.reclaim-${dead.pid}`, old, old);
  // Each contender is its own process and stays alive a while, as a review holding the lock would.
  const code = `const { acquireLock } = await import(${JSON.stringify(watcher)});
console.log(await acquireLock(${JSON.stringify(lock)}));
await new Promise(done => setTimeout(done, 1500));`;
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    execFileAsync(process.execPath, ['--input-type=module', '-e', code]).then(({ stdout }) => stdout.trim())));
  assert.equal(results.filter(result => result === 'true').length, 1);
});

test('recordは、rtが渡したロックが自分のものなら外し、投稿したcommitをレビュー済みとして残す', async () => {
  const t = await setup();
  const lock = `${t.stateFile}.lock`;
  await mkdir(join(lock, '..'), { recursive: true });
  await writeFile(lock, String(process.pid));
  const out = await mkdtemp(join(t.dir, 'out-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'aaa', pr: { url: prUrl } } }));
  await writeFile(join(out, 'reviewed.diff'), '');
  const record = token => execFileAsync(process.execPath, [watcher, 'record', '--output', out, '--act-on', '1'],
    { env: { ...t.env, REVIEW_TEAM_PR_LOCK: token } });
  // rt's own record registers the watch even though rt holds the lock.
  assert.equal(JSON.parse((await record(String(process.pid + 1))).stdout).registered, true);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  await record(String(process.pid));
  await assert.rejects(stat(lock));
  assert.equal(JSON.parse(await readFile(`${t.stateFile}.reviewed`, 'utf8')).completedHead, 'aaa');
});

test('ウォッチが解除されたあとの再レビューの記録でも、投稿したcommitはレビュー済みとして残す', async () => {
  const t = await setup();
  const out = await mkdtemp(join(t.dir, 'out-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'bbb', pr: { url: prUrl } } }));
  await writeFile(join(out, 'reviewed.diff'), '');
  const { stdout } = await execFileAsync(process.execPath, [watcher, 'record', '--output', out, '--act-on', '1'],
    { env: { ...t.env, REVIEW_TEAM_WATCH_POSTING: join(t.dir, 'posting') } });
  assert.equal(JSON.parse(stdout).registered, false);
  await assert.rejects(stat(t.stateFile));
  assert.equal(JSON.parse(await readFile(`${t.stateFile}.reviewed`, 'utf8')).completedHead, 'bbb');
});

test('rtのロックはcronの行に入らず、deferでも外れる。rtのレビュー中はtickが再レビューを見送る', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-a\n');
  await t.register('aaa');
  await t.setPr({ headRefOid: 'bbb' });
  const lock = `${t.stateFile}.lock`;
  await writeFile(lock, String(process.pid));
  assert.match(await t.tick(), / skip \(running\)$/m);
  const out = await mkdtemp(join(t.dir, 'out-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'bbb', pr: { url: prUrl } } }));
  await writeFile(join(out, 'reviewed.diff'), '');
  const { stdout } = await execFileAsync(process.execPath, [watcher, 'defer', '--output', out],
    { env: { ...t.env, REVIEW_TEAM_PR_LOCK: String(process.pid) } });
  if (process.platform !== 'darwin') assert.doesNotMatch(JSON.parse(stdout).schedule.cron, /REVIEW_TEAM_PR_LOCK/);
  await assert.rejects(stat(lock));
  // defer posted nothing, so the head is not recorded as reviewed.
  assert.equal(JSON.parse(await readFile(`${t.stateFile}.reviewed`, 'utf8')).completedHead, 'aaa');
});

test('中身の無いロックは、1分たつまで取らず、過ぎたら回収する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-lock-'));
  const lock = join(dir, 'pr.lock');
  await writeFile(lock, '');
  const { acquireLock } = await import(watcher);
  assert.equal(await acquireLock(lock), false);
  const old = new Date(Date.now() - 120000);
  await utimes(lock, old, old);
  assert.equal(await acquireLock(lock), true);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
});

// The notifier is looked for in /Applications first, so these tests cannot control it on a machine that has it there.
const hasSystemNotifier = Boolean(await stat('/Applications/terminal-notifier.app').catch(() => null));
const notifyTest = (name, fn) => test(name, { skip: hasSystemNotifier }, fn);
const openArgs = (t, title, message) => `-n|${t.app}|--args|-title|${title}|-subtitle|acme/widget#7|-message|${message}|-sound|default|-open|${prUrl}|-group|${prUrl}|`;

async function ready(setupEnv) {
  const t = await setup(setupEnv);
  await t.installApp();
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'aaa' });
  await t.register('aaa', [], '0');
  return t;
}

notifyTest('Act Onが0件の投稿は、条件がそろったtickで1回通知し、1・2・4…時間の時点でリマインドする', async () => {
  const t = await ready();
  assert.match(await t.tick(), / notify \(0h\)$/m);
  assert.deepEqual(await t.opens(), [openArgs(t, 'Review Team (0h)', 'Act On なし、CI 成功。Approve できます')]);
  assert.equal((await t.notifyState()).lastMark, 0);
  assert.doesNotMatch(await t.tick(), / notify /);
  assert.equal((await t.opens()).length, 1);

  // Five hours on, the marks at 1, 2 and 4 hours have passed: one reminder, named after the latest.
  await t.age('notifiedAt', 5);
  assert.match(await t.tick(), / notify \(4h\)$/m);
  assert.equal((await t.opens())[1], openArgs(t, 'Review Team Reminder (4h)', 'Approve 忘れがあります'));
  assert.doesNotMatch(await t.tick(), / notify /);
  assert.equal((await t.opens()).length, 2);
});

notifyTest('条件が欠けている間は最初の通知を待ち、そろったら通知する。mergeableが計算中のtickは何も変えない', async () => {
  const t = await ready();
  const notReady = [
    { isDraft: true }, { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' },
    { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
    { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
    { reviewThreads: { totalCount: 2, nodes: [{ isResolved: true }, { isResolved: false }] } },
    { reviewThreads: { totalCount: 101, nodes: [{ isResolved: true }] } },
    // Past 100 verdicts the viewer's own may be out of sight.
    { reviews: { totalCount: 101, nodes: [{ viewerDidAuthor: false, commit: { oid: 'aaa' } }] } },
    // An approval of an older commit does not answer for this head.
    { headRefOid: 'aaa', mergeable: 'CONFLICTING', reviews: { totalCount: 1, nodes: [{ viewerDidAuthor: true, commit: { oid: '000' } }] } },
  ];
  for (const fields of notReady) {
    await t.setPr(fields);
    assert.doesNotMatch(await t.tick(), / notify /, JSON.stringify(fields));
  }
  assert.deepEqual(await t.opens(), []);
  assert.equal((await t.notifyState()).notifiedAt, undefined);

  // A repository with no CI counts as passing, and resolved threads do not hold the notification back.
  await t.setPr({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] },
    reviews: { totalCount: 2, nodes: [{ viewerDidAuthor: true, commit: { oid: '000' } }, { viewerDidAuthor: false, commit: { oid: 'aaa' } }] } });
  assert.match(await t.tick(), / notify \(0h\)$/m);
  assert.equal((await t.opens()).length, 1);
});

notifyTest('条件が欠けたリマインダーの回は見送り、次の時刻でまた確かめる。計算中なら次のtickで確かめる', async () => {
  const t = await ready();
  await t.tick();
  await t.age('notifiedAt', 1.5);
  await t.setPr({ mergeable: 'UNKNOWN' });
  await t.tick();
  assert.equal((await t.notifyState()).lastMark, 0);
  await t.setPr({ isDraft: true });
  await t.tick();
  assert.equal((await t.notifyState()).lastMark, 1);
  await t.setPr({});
  assert.doesNotMatch(await t.tick(), / notify /);
  assert.equal((await t.opens()).length, 1);
  await t.age('notifiedAt', 2.5);
  assert.match(await t.tick(), / notify \(2h\)$/m);
});

notifyTest('マージ・そのheadへの自分のレビュー・自分のPRは、通知せずに記録を消す', async () => {
  for (const [fields, reason] of [
    [{ state: 'MERGED' }, 'merged'], [{ state: 'CLOSED' }, 'closed'], [{ viewerDidAuthor: true }, 'own'],
    [{ reviews: { totalCount: 1, nodes: [{ viewerDidAuthor: true, commit: { oid: 'aaa' } }] } }, 'answered'],
  ]) {
    const t = await ready();
    await t.setPr(fields);
    assert.match(await t.tick(), new RegExp(` notify remove \\(${reason}\\)$`, 'm'));
    await assert.rejects(stat(t.notifyFile));
    assert.deepEqual(await t.opens(), []);
  }
});

test('Act Onがある投稿は通知の記録を消し、--act-onの無いrecordは何も書かずに失敗する', async () => {
  const t = await ready();
  await stat(t.notifyFile);
  await t.register('aaa', [], '2');
  await assert.rejects(stat(t.notifyFile));

  const out = await mkdtemp(join(t.dir, 'out-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'bbb', pr: { url: prUrl } } }));
  await writeFile(join(out, 'reviewed.diff'), '');
  await assert.rejects(t.cli('record', '--output', out), /--act-on/);
  assert.equal(JSON.parse(await readFile(`${t.stateFile}.reviewed`, 'utf8')).completedHead, 'aaa');
});

notifyTest('pushでheadが進むと通知を止め、差分が同じpushなら新しいheadでリマインドを続ける', async () => {
  const t = await ready();
  await t.tick();
  await t.setPr({ headRefOid: 'bbb' });
  await t.age('notifiedAt', 1.5);
  // The reminder at 1 hour finds another head: nothing is sent while the watch waits for the pushes to settle.
  assert.match(await t.tick(), / observe \(settling\)$/m);
  const out = await t.tick();
  assert.match(out, / same-diff$/m);
  assert.doesNotMatch(out, / notify /);
  assert.deepEqual((await t.notifyState()).heads, ['aaa', 'bbb']);
  assert.equal((await t.opens()).length, 1);
  await t.age('notifiedAt', 2.5);
  assert.match(await t.tick(), / notify \(2h\)$/m);

  // An approval of the reviewed commit answers for the later head with the same diff.
  await t.setPr({ headRefOid: 'bbb', reviews: { totalCount: 1, nodes: [{ viewerDidAuthor: true, commit: { oid: 'aaa' } }] } });
  await t.age('notifiedAt', 4.5);
  assert.match(await t.tick(), / notify remove \(answered\)$/m);
  assert.equal((await t.opens()).length, 2);
});

notifyTest('見えなくなったPRの記録は消し、GitHubに届かない間は記録を変えずに次のtickで確かめる', async () => {
  const t = await ready();
  await t.tick();
  await t.age('notifiedAt', 1.5);
  const realGh = await readFile(join(t.dir, 'bin', 'gh'), 'utf8');
  await writeFile(join(t.dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n');
  await t.cli('tick');
  assert.equal((await t.notifyState()).lastMark, 0);
  // gh prints GitHub's answer and then fails when the PR cannot be resolved.
  await writeFile(join(t.dir, 'bin', 'gh'), `#!/bin/sh\necho '{"data":{"resource":null},"errors":[{"type":"NOT_FOUND"}]}'\nexit 1\n`);
  assert.match(await t.cli('tick').then(r => r.stdout), / notify remove \(gone\)$/m);
  await assert.rejects(stat(t.notifyFile));
  await writeFile(join(t.dir, 'bin', 'gh'), realGh);
});

notifyTest('GitHubに問い合わせている間に記録が置き換わったら、古い記録への答えで通知も削除もしない', async () => {
  const t = await ready();
  const realGh = await readFile(join(t.dir, 'bin', 'gh'), 'utf8');
  const during = join(t.dir, 'during-query');
  // gh runs the test's command just before it answers the notify query, as a review finishing meanwhile would.
  await writeFile(join(t.dir, 'bin', 'gh'), realGh.replace('#!/bin/sh\n',
    `#!/bin/sh\ncase "$*" in *reviewThreads*) sh "${during}" ;; esac\n`));
  // The viewer approved aaa, but the record now is about bbb.
  const replaced = { pr: prUrl, heads: ['bbb'], recordedAt: new Date(Date.now() + 1000).toISOString() };
  await writeFile(join(t.dir, 'replaced'), JSON.stringify(replaced));
  await writeFile(during, `cp "${join(t.dir, 'replaced')}" "${t.notifyFile}"\n`);
  await t.setPr({ reviews: { totalCount: 1, nodes: [{ viewerDidAuthor: true, commit: { oid: 'aaa' } }] } });
  assert.doesNotMatch(await t.tick(), / notify /);
  assert.deepEqual(await t.notifyState(), replaced);

  // rt --force found Act On and removed the record, while GitHub says the PR is ready.
  await t.register('aaa', [], '0');
  await writeFile(during, `rm "${t.notifyFile}"\n`);
  await t.setPr({});
  assert.doesNotMatch(await t.tick(), / notify /);
  assert.deepEqual(await t.opens(), []);
  await assert.rejects(stat(t.notifyFile));
  await writeFile(join(t.dir, 'bin', 'gh'), realGh);
});

notifyTest('再レビュー中に解除したウォッチは、その再レビューの記録で通知の対象に戻らない', async () => {
  const t = await ready();
  await t.cli('remove', prUrl);
  const out = await mkdtemp(join(t.dir, 'out-'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ repository: { commit: 'aaa', pr: { url: prUrl } } }));
  await writeFile(join(out, 'reviewed.diff'), '');
  await execFileAsync(process.execPath, [watcher, 'record', '--output', out, '--act-on', '0'],
    { env: { ...t.env, REVIEW_TEAM_WATCH_POSTING: join(t.dir, 'posting') } });
  await assert.rejects(stat(t.notifyFile));
});

notifyTest('レビュー中のPRは通知を待ち、removeは通知の記録も消す', async () => {
  const t = await ready();
  await writeFile(`${t.stateFile}.lock`, String(process.pid));
  assert.doesNotMatch(await t.cli('tick').then(r => r.stdout), / notify /);
  await rm(`${t.stateFile}.lock`);
  await t.cli('remove', prUrl);
  await assert.rejects(stat(t.notifyFile));
  await t.tick();
  assert.deepEqual(await t.opens(), []);
});

notifyTest('terminal-notifierが無ければ通知せずに記録を残し、条件がそろわないまま7日たった記録は消す', async () => {
  const t = await ready();
  await rm(t.app, { recursive: true });
  assert.doesNotMatch(await t.tick(), / notify /);
  assert.deepEqual(await t.opens(), []);
  await stat(t.notifyFile);

  await t.age('recordedAt', 7 * 24 + 1);
  assert.match(await t.tick(), / notify remove \(expired\)$/m);
  await assert.rejects(stat(t.notifyFile));
});
