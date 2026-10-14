import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const watcher = new URL('../skills/review-team/scripts/watch-pr.mjs', import.meta.url).pathname;
const prUrl = 'https://example.test/acme/widget/pull/7';
const minutesAgo = minutes => new Date(Date.now() - minutes * 60 * 1000).toISOString();

async function setup() {
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
out="${dir}/out-$$"
mkdir "$out"
head=$(sed -n 's/.*"headRefOid":"\\([^"]*\\)".*/\\1/p' "${pr}")
printf '{"repository":{"commit":"%s","pr":{"url":"${prUrl}"}}}' "$head" > "$out/manifest.json"
cp "${diff}" "$out/reviewed.diff"
"${process.execPath}" "${watcher}" record --output "$out" > /dev/null
`);
  await chmod(join(bin, 'gh'), 0o755);
  await chmod(lead, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state'), REVIEW_TEAM_LEAD_CLI: lead };
  delete env.REVIEW_TEAM_DEPTH;
  const setPr = (fields) => writeFile(pr, JSON.stringify({ data: { resource: {
    state: 'OPEN', isDraft: false, headRefOid: 'aaa', committedDate: minutesAgo(30), ...fields,
  } } }).replace(/"committedDate":("[^"]*")/, '"commits":{"nodes":[{"commit":{"committedDate":$1}}]}'));
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
  return { dir, diff, leadLog, setPr, cli, state, tick, register };
}

test('recordはPRを12時間登録し、tickはLLMを起動せずにpushが無いPRを見送る', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'aaa' });
  const result = await t.register('aaa', ['--effort', 'max']);
  assert.equal(result.registered, true);
  assert.match(result.schedule.cron, /^\*\/10 \* \* \* \* .* tick /);
  const s = await t.state();
  assert.equal(s.effort, 'max');
  assert.equal(s.maxRereviews, 3);
  assert.equal(Date.parse(s.expiresAt) - Date.parse(s.registeredAt), 12 * 3600 * 1000);
  assert.match(await t.tick(), /skip \(reviewed\)/);
  assert.equal(await readFile(t.leadLog, 'utf8').catch(() => ''), '');
});

test('新しいpushは10分経ってから再レビューし、差分が同じpushは見送る', async () => {
  const t = await setup();
  await writeFile(t.diff, 'diff-1\n');
  await t.setPr({ headRefOid: 'aaa' });
  await t.register('aaa');

  await t.setPr({ headRefOid: 'bbb', committedDate: minutesAgo(3) });
  assert.match(await t.tick(), /skip \(settling\)/);
  await t.setPr({ headRefOid: 'bbb', isDraft: true });
  assert.match(await t.tick(), /skip \(draft\)/);

  await t.setPr({ headRefOid: 'bbb' });
  assert.match(await t.tick(), /same-diff/);
  assert.equal((await t.state()).lastReviewedCommit, 'bbb');
  assert.equal((await t.state()).rereviews, 0);

  await writeFile(t.diff, 'diff-2\n');
  await t.setPr({ headRefOid: 'ccc' });
  assert.match(await t.tick(), /review/);
  const s = await t.state();
  assert.equal(s.lastReviewedCommit, 'ccc');
  assert.equal(s.rereviews, 1);
  assert.equal(s.failures, 0);
  assert.match(await readFile(t.leadLog, 'utf8'), /^-p --effort xhigh --permission-mode auto \/review-team --comment --rereview 1\/3 https:\/\/example\.test\/acme\/widget\/pull\/7\n$/);
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
  await t.tick();
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
