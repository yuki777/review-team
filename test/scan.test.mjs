import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scanner = new URL('../skills/review-team/scripts/scan-prs.mjs', import.meta.url).pathname;
const watcher = new URL('../skills/review-team/scripts/watch-pr.mjs', import.meta.url).pathname;
const url = n => `https://github.com/acme/widget/pull/${n}`;

// gh answers the search, and rt's question about one PR, from a file the test writes.
// The fake claude records each review it is started for, and with claude-posts records its post as the lead does.
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-scan-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const search = join(dir, 'search.json');
  const ghLog = join(dir, 'gh.log');
  const claudeLog = join(dir, 'claude.log');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, args.join('\\n') + '\\n');
const search = fs.readFileSync(${JSON.stringify(search)}, 'utf8');
const url = args.find(arg => arg.startsWith('url='))?.slice(4);
if (!url) { process.stdout.write(search); process.exit(0); }
const pr = JSON.parse(search).data.search.nodes.find(node => node.url === url);
process.stdout.write(JSON.stringify({ data: { resource: { url, state: 'OPEN', isDraft: false, headRefOid: pr.headRefOid } } }));
`);
  await writeFile(join(bin, 'claude'), `#!/bin/sh
# The sleep ignores SIGTERM, as a reviewer that does not stop would.
[ -f "${join(dir, 'claude-hangs')}" ] && { trap '' TERM; sleep 60 & echo $! >> "${join(dir, 'sleep.pid')}"; trap - TERM; wait; }
echo "$*" >> "${claudeLog}"
if [ -f "${join(dir, 'claude-posts')}" ]; then
  for prompt; do :; done
  url=\${prompt##* }
  out=$(mktemp -d "${dir}/out-XXXXXX")
  head=$(gh api graphql -f "url=$url" | sed -n 's/.*"headRefOid":"\\([^"]*\\)".*/\\1/p')
  printf '{"repository":{"commit":"%s","pr":{"url":"%s"}}}' "$head" "$url" > "$out/manifest.json"
  : > "$out/reviewed.diff"
  "${process.execPath}" "${watcher}" record --output "$out" > /dev/null
fi
# A push or a red CI while this review runs changes what the next search returns.
[ -f "${join(dir, 'next-search.json')}" ] && mv "${join(dir, 'next-search.json')}" "${search}"
`);
  await chmod(join(bin, 'gh'), 0o755);
  await chmod(join(bin, 'claude'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state'), REVIEW_TEAM_SCAN_TIMEOUT: '1' };
  delete env.REVIEW_TEAM_DEPTH;
  const setPrs = (prs, file = search) => writeFile(file, JSON.stringify({ data: { search: { nodes: prs.map(pr => ({
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
  const { stdout } = await scan('--team', 'opus-sol');
  assert.match(await readFile(ghLog, 'utf8'), /^q=is:pr is:open draft:false archived:false -author:app\/renovate user-review-requested:@me org:acme$/m);
  for (const [n, reason] of [[2, 'conflict'], [3, 'mergeable unknown'], [4, 'ci failed'], [5, 'ci failed'], [6, 'ci running'], [7, 'ci running']]) {
    assert.match(stdout, new RegExp(`${url(n)} skip \\(${reason}\\)`));
  }
  assert.match(stdout, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} https:\/\/github\.com\/acme\/widget\/pull\/1 review aaa$/m);
  assert.match(stdout, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} scan 終了: レビュー 2 件、見送り 6 件$/m);
  const team = '--reviewer claude:claude-opus-5-5:high --reviewer codex:gpt-6.1-sol:high';
  assert.deepEqual(await reviews(), [1, 8].map(n =>
    `-p --effort xhigh --permission-mode auto /review-team --comment --watch ${team} ${url(n)}`));
});

test('--with-considerならレビューに--with-considerを付ける。--act-on-onlyは受け付けない', async () => {
  const { setPrs, scan, reviews } = await setup();
  await setPrs([{ n: 1 }]);
  await scan();
  await setPrs([{ n: 2 }]);
  await scan('--with-consider');
  const lead = '-p --effort xhigh --permission-mode auto /review-team --comment --watch';
  assert.deepEqual(await reviews(), [`${lead} ${url(1)}`, `${lead} --with-consider ${url(2)}`]);
  await assert.rejects(scan('--act-on-only'), /act-on-only/);
});

test('依頼が無くても、時刻付きの終了の行と件数を1行出す', async () => {
  const { setPrs, scan, reviews } = await setup();
  await setPrs([]);
  const { stdout } = await scan();
  assert.match(stdout, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} scan 終了: レビュー 0 件、見送り 0 件\n$/);
  assert.deepEqual(await reviews(), []);
});

test('投稿まで終わらなかったheadは次の回で1回だけやり直し、新しいheadならレビューする。ウォッチ中のPRは見送る', async () => {
  const { dir, setPrs, scan, reviews } = await setup();
  await setPrs([{ n: 1 }]);
  assert.match((await scan()).stdout, / review aaa$/m);
  // The same scan does not start the failed head again; the next scan tries it once more.
  assert.equal((await reviews()).length, 1);
  assert.match((await scan()).stdout, / review aaa$/m);
  assert.match((await scan()).stdout, /skip \(failed\)/);
  assert.equal((await reviews()).length, 2);
  await setPrs([{ n: 1, head: 'bbb' }]);
  await scan();
  assert.equal((await reviews()).length, 3);
  const watch = join(dir, 'state', 'review-team', 'watch', 'prs', 'github.com', 'acme', 'widget');
  await mkdir(watch, { recursive: true });
  await writeFile(join(watch, '1.json'), JSON.stringify({ pr: url(1), stoppedReason: null }));
  await setPrs([{ n: 1, head: 'ccc' }]);
  const { stdout } = await scan();
  assert.match(stdout, /skip \(watched\)/);
  assert.equal((await reviews()).length, 3);
});

test('投稿を記録したheadは、ウォッチが終わったあとも見送る', async () => {
  const { dir, env, setPrs, scan, reviews } = await setup();
  await writeFile(join(dir, 'claude-posts'), '');
  await setPrs([{ n: 1 }]);
  await scan();
  await execFileAsync(process.execPath, [watcher, 'remove', url(1)], { env });
  const { stdout } = await scan();
  assert.match(stdout, /skip \(reviewed\)/);
  assert.match(stdout, /scan 終了: レビュー 0 件、見送り 0 件/);
  assert.equal((await reviews()).length, 1);
});

test('同じPRのレビューが実行中なら、claudeを起動せずに見送る', async () => {
  const { dir, setPrs, scan, reviews } = await setup();
  const lock = join(dir, 'state', 'review-team', 'watch', 'prs', 'github.com', 'acme', 'widget', '1.json.lock');
  await mkdir(join(lock, '..'), { recursive: true });
  await writeFile(lock, String(process.pid));
  await setPrs([{ n: 1 }]);
  assert.match((await scan()).stdout, /skip \(running\)/);
  assert.deepEqual(await reviews(), []);
});

test('レビューのたびに検索し直し、待っている間にCIが赤くなったPRは始めない', async () => {
  const { dir, setPrs, scan, reviews } = await setup();
  await setPrs([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await setPrs([{ n: 1 }, { n: 2, ci: 'FAILURE' }, { n: 3 }], join(dir, 'next-search.json'));
  const { stdout } = await scan();
  assert.match(stdout, new RegExp(`${url(2)} skip \\(ci failed\\)`));
  assert.deepEqual((await reviews()).map(line => line.split(' ').at(-1)), [url(1), url(3)]);
});

test('止まらないレビューは、SIGTERMを無視する子も含めて制限時間で止め、次のPRへ進む', async () => {
  const { dir, setPrs, scan } = await setup();
  await writeFile(join(dir, 'claude-hangs'), '');
  await setPrs([{ n: 1 }, { n: 2 }]);
  const started = Date.now();
  const { stdout } = await scan();
  assert.ok(Date.now() - started < 10000);
  assert.match(stdout, new RegExp(`${url(1)} exit SIGTERM`));
  assert.match(stdout, new RegExp(`${url(2)} review`));
  // The whole process group is stopped, so nothing the lead started is left running.
  for (const pid of (await readFile(join(dir, 'sleep.pid'), 'utf8')).trim().split('\n')) {
    const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i++) await new Promise(done => setTimeout(done, 50));
    assert.equal(alive(), false);
  }
});

test('--orgか--repoのどちらか一方でなければ止まる', async () => {
  const { env } = await setup();
  await assert.rejects(execFileAsync(process.execPath, [scanner, 'scan'], { env }), /--org か --repo のどちらか一方/);
  await assert.rejects(execFileAsync(process.execPath, [scanner, 'scan', '--org', 'acme', '--repo', 'acme/widget'], { env }),
    /--org か --repo のどちらか一方/);
});

test('スキルのディレクトリがシンボリックリンクでも、scan-prs.mjs と watch-pr.mjs は動く', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-link-'));
  await symlink(new URL('../skills/review-team', import.meta.url).pathname, join(dir, 'skill'));
  for (const name of ['scan-prs.mjs', 'watch-pr.mjs']) {
    const { stdout } = await execFileAsync(process.execPath, [join(dir, 'skill', 'scripts', name), '--help']);
    assert.match(stdout, /review-team/, name);
  }
});

test('--repo owner/nameを付けると、組織全体ではなくそのリポジトリだけを検索する。owner/name以外は拒む', async () => {
  const { env, setPrs, ghLog } = await setup();
  await setPrs([]);
  await execFileAsync(process.execPath, [scanner, 'scan', '--repo', 'acme/widget', '--repo', 'other/HCAA.S4'], { env });
  assert.match(await readFile(ghLog, 'utf8'), /^q=is:pr is:open draft:false archived:false -author:app\/renovate user-review-requested:@me repo:acme\/widget repo:other\/HCAA\.S4$/m);
  for (const repo of ['widget', 'a/b/c', 'acme/widget org:evil', '']) {
    await assert.rejects(execFileAsync(process.execPath, [scanner, 'scan', '--repo', repo], { env }),
      /--repo は owner\/name の形で指定してください/, repo);
  }
});

test('scanをSIGINTで止めると、別のプロセスグループで動いているレビューも止める', async () => {
  const { dir, env, setPrs } = await setup();
  await writeFile(join(dir, 'claude-hangs'), '');
  await setPrs([{ n: 1 }]);
  const child = spawn(process.execPath, [scanner, 'scan', '--org', 'acme'], { env: { ...env, REVIEW_TEAM_SCAN_TIMEOUT: '600' }, stdio: 'ignore' });
  const pidFile = join(dir, 'sleep.pid');
  for (let i = 0; i < 100 && !(await readFile(pidFile, 'utf8').catch(() => '')); i++) await new Promise(done => setTimeout(done, 50));
  child.kill('SIGINT');
  assert.equal(await new Promise(done => child.on('exit', (code, signal) => done(signal))), 'SIGINT');
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise(done => setTimeout(done, 50));
  assert.equal(alive(), false);
  // The stopped review counts as one attempt, so the next scan tries the same head once more.
  await rm(join(dir, 'claude-hangs'));
  const { stdout } = await execFileAsync(process.execPath, [scanner, 'scan', '--org', 'acme'], { env });
  assert.match(stdout, new RegExp(`${url(1)} review aaa`));
});
