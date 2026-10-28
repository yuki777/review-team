import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scanner = new URL('../skills/review-team/scripts/scan-prs.mjs', import.meta.url).pathname;
const url = n => `https://github.com/acme/widget/pull/${n}`;

// gh answers the search from a file the test writes; the fake claude records each review it is started for.
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-scan-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const search = join(dir, 'search.json');
  const ghLog = join(dir, 'gh.log');
  const claudeLog = join(dir, 'claude.log');
  await writeFile(join(bin, 'gh'), `#!/bin/sh
for arg; do echo "$arg" >> "${ghLog}"; done
cat "${search}"
`);
  await writeFile(join(bin, 'claude'), `#!/bin/sh
[ -f "${join(dir, 'claude-hangs')}" ] && { sleep 60 & echo $! >> "${join(dir, 'sleep.pid')}"; wait; }
echo "$*" >> "${claudeLog}"
`);
  await chmod(join(bin, 'gh'), 0o755);
  await chmod(join(bin, 'claude'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state'), REVIEW_TEAM_SCAN_TIMEOUT: '1' };
  delete env.REVIEW_TEAM_DEPTH;
  const setPrs = prs => writeFile(search, JSON.stringify({ data: { search: { nodes: prs.map(pr => ({
    url: url(pr.n), headRefOid: pr.head ?? 'aaa', mergeable: pr.mergeable ?? 'MERGEABLE',
    commits: { nodes: [{ commit: { statusCheckRollup: pr.ci === undefined ? { state: 'SUCCESS' } : pr.ci && { state: pr.ci } } }] },
  })) } } }));
  const scan = (...args) => execFileAsync(process.execPath, [scanner, 'scan', '--org', 'acme', ...args], { env });
  const reviews = () => readFile(claudeLog, 'utf8').then(text => text.trimEnd().split('\n'), () => []);
  return { dir, env, setPrs, scan, reviews, ghLog };
}

test('自分宛ての依頼を組織で検索し、コンフリクト・計算中・CI失敗・CI実行中を見送る', async () => {
  const { setPrs, scan, reviews, ghLog } = await setup();
  await setPrs([
    { n: 1 }, { n: 2, mergeable: 'CONFLICTING' }, { n: 3, mergeable: 'UNKNOWN' },
    { n: 4, ci: 'FAILURE' }, { n: 5, ci: 'ERROR' }, { n: 6, ci: 'PENDING' }, { n: 7, ci: 'EXPECTED' }, { n: 8, ci: null },
  ]);
  const { stdout } = await scan('--team', 'opus-sol', '--act-on-only');
  assert.match(await readFile(ghLog, 'utf8'), /^q=is:pr is:open draft:false archived:false user-review-requested:@me org:acme$/m);
  for (const [n, reason] of [[2, 'conflict'], [3, 'mergeable unknown'], [4, 'ci failed'], [5, 'ci failed'], [6, 'ci running'], [7, 'ci running']]) {
    assert.match(stdout, new RegExp(`${url(n)}: skip \\(${reason}\\)`));
  }
  const team = '--reviewer claude:claude-opus-5-5:high --reviewer codex:gpt-6.1-sol:high';
  assert.deepEqual(await reviews(), [1, 8].map(n =>
    `-p --effort xhigh --permission-mode auto /review-team --comment --watch --act-on-only ${team} ${url(n)}`));
});

test('同じheadは失敗しても次の回でやり直さず、新しいheadならレビューする。ウォッチ中のPRは見送る', async () => {
  const { dir, setPrs, scan, reviews } = await setup();
  await setPrs([{ n: 1 }]);
  await scan();
  await scan();
  assert.equal((await reviews()).length, 1);
  await setPrs([{ n: 1, head: 'bbb' }]);
  await scan();
  assert.equal((await reviews()).length, 2);
  const watch = join(dir, 'state', 'review-team', 'watch', 'prs', 'github.com', 'acme', 'widget');
  await mkdir(watch, { recursive: true });
  await writeFile(join(watch, '1.json'), JSON.stringify({ pr: url(1), stoppedReason: null }));
  await setPrs([{ n: 1, head: 'ccc' }]);
  const { stdout } = await scan();
  assert.match(stdout, /skip \(watched\)/);
  assert.equal((await reviews()).length, 2);
});

test('止まらないレビューは制限時間で止め、次のPRへ進む', async () => {
  const { dir, setPrs, scan } = await setup();
  await writeFile(join(dir, 'claude-hangs'), '');
  await setPrs([{ n: 1 }, { n: 2 }]);
  const started = Date.now();
  const { stdout } = await scan();
  assert.ok(Date.now() - started < 10000);
  assert.match(stdout, new RegExp(`${url(1)}: exit SIGTERM`));
  assert.match(stdout, new RegExp(`${url(2)}: review`));
  // The whole process group is stopped, so nothing the lead started is left running.
  for (const pid of (await readFile(join(dir, 'sleep.pid'), 'utf8')).trim().split('\n')) {
    const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i++) await new Promise(done => setTimeout(done, 50));
    assert.equal(alive(), false);
  }
});

test('--orgが無ければ止まる', async () => {
  const { env } = await setup();
  await assert.rejects(execFileAsync(process.execPath, [scanner, 'scan'], { env }), /--orgが必要です/);
});
