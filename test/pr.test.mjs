import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const runner = new URL('../skills/review-team/scripts/run-reviewers.mjs', import.meta.url).pathname;

async function setup({ cloneDelay = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const work = join(dir, 'work');
  const remote = join(dir, 'remote.git');
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  await writeFile(join(work, 'lib.js'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  execFileSync('git', ['clone', '-q', '--bare', work, remote]);
  await writeFile(join(work, 'lib.js'), 'pr-head\n');
  git('commit', '-qam', 'change');
  const head = git('rev-parse', 'HEAD');
  git('push', '-q', remote, `HEAD:refs/pull/7/head`);
  const headFile = join(dir, 'head');
  await writeFile(headFile, head);

  const bin = join(dir, 'bin');
  await mkdir(bin);
  const ghLog = join(dir, 'gh.log');
  await writeFile(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$*" in
  "pr view 7 "*) echo '{"number":7,"url":"https://example.test/acme/widget/pull/7","title":"PRのタイトル","body":"PRの本文","baseRefName":"main","headRefOid":"'"$(cat "${headFile}")"'"}' ;;
  "pr view https:"*) echo '{"headRefOid":"'"$(cat "${headFile}2" 2>/dev/null || cat "${headFile}")"'"}' ;;
  "pr diff "*) printf 'diff --git a/lib.js b/lib.js\\n-base\\n+pr-head\\n' ;;
  "repo clone "*) sleep ${cloneDelay}; git clone -q --no-checkout "${remote}" "$4" ;;
  *) exit 1 ;;
esac
`);
  await chmod(join(bin, 'gh'), 0o755);
  const report = join(dir, 'report');
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = --add-dir ] && clone="$2"; shift; done
cat "$clone/lib.js" > "${report}"
echo '{"type":"result","subtype":"success","is_error":false,"result":"指摘なし","modelUsage":{}}'
`);
  await chmod(cli, 0o755);

  const state = join(dir, 'state');
  const runWithLog = async (output, extraArgs = []) => {
    const child = spawn(process.execPath, [runner, '--pr', '7', '--output', join(dir, output), '--reviewer', 'claude:m', ...extraArgs], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, XDG_STATE_HOME: state, REVIEW_TEAM_CLAUDE_CLI: cli },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    return { code, stderr };
  };
  const run = async (...args) => (await runWithLog(...args)).code;
  const cache = join(state, 'review-team', 'repos', 'example.test', 'acme', 'widget');
  return { dir, head, headFile, git, remote, ghLog, report, cache, run, runWithLog };
}

test('--prはリポジトリをキャッシュにクローンし、PRのheadを読ませ、資料をPRから補う', async () => {
  const { dir, head, ghLog, report, cache, run } = await setup();
  assert.equal(await run('out1'), 0);
  assert.equal(await run('out2'), 0);
  assert.equal(await readFile(report, 'utf8'), 'pr-head\n');
  const manifest = JSON.parse(await readFile(join(dir, 'out2', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.repository, { path: cache, ref: 'pull/7/head', commit: head,
    pr: { url: 'https://example.test/acme/widget/pull/7', number: 7, base: 'main' } });
  const prompt = await readFile(join(dir, 'out2', 'prompt.md'), 'utf8');
  assert.match(prompt, /PRのタイトル\n\nPRの本文/);
  assert.match(prompt, /\+pr-head/);
  assert.equal(await readFile(join(dir, 'out2', 'reviewed.diff'), 'utf8'), 'diff --git a/lib.js b/lib.js\n-base\n+pr-head\n');
  assert.equal((await readFile(ghLog, 'utf8')).split('\n').filter(line => line.startsWith('repo clone')).length, 1);

  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '独自の意図', diff: 'diff --git a/own.js b/own.js\n+own\n' }));
  assert.equal(await run('out3', ['--packet', join(dir, 'packet.json')]), 0);
  assert.equal(await readFile(join(dir, 'out3', 'reviewed.diff'), 'utf8'), 'diff --git a/own.js b/own.js\n+own\n',
    'reviewed.diff records the diff the reviewers saw, not the one from gh pr diff');
  assert.match(await readFile(join(dir, 'out3', 'prompt.md'), 'utf8'), /\+own/);
  await rm(dir, { recursive: true, force: true });
});

test('--prと--repoは同時に指定できない', async () => {
  const child = spawn(process.execPath, [runner, '--pr', '1', '--repo', '.', '--output', join(tmpdir(), 'unused')], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 2);
});

test('--prは段階ごとの進捗をstderrに書く。クローンの行は初回だけ出る', async () => {
  const { dir, runWithLog } = await setup();
  const first = await runWithLog('out1');
  assert.equal(first.code, 0);
  const stages = ['PRを取得しています', 'リポジトリをキャッシュへクローンしています', 'PRのコミットを取得しています',
    'PRの差分を取得しています', 'レビュアーを起動しました: claude', 'claude が終わりました: ok'];
  const lines = first.stderr.trim().split('\n');
  const indexes = stages.map(stage => lines.findIndex(line => line.includes(stage)));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), first.stderr);
  assert.ok(!indexes.includes(-1), first.stderr);
  assert.ok(lines.every(line => /^\[review-team \d{4}-\d\d-\d\dT[^\]]+\] /.test(line)), first.stderr);
  const second = await runWithLog('out2');
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.stderr, /クローンしています/);
  await rm(dir, { recursive: true, force: true });
});

test('--prを同じリポジトリで並行して初回起動しても、両方が完成したキャッシュを使う', async () => {
  const { dir, cache, run } = await setup({ cloneDelay: 1 });
  assert.deepEqual(await Promise.all([run('out1'), run('out2')]), [0, 0]);
  assert.deepEqual((await readdir(dirname(cache))).filter(name => name !== 'widget'), [], 'クローン途中の一時ディレクトリが残っています');
  await rm(dir, { recursive: true, force: true });
});

test('--prはrefs/pull/N/headがPRのheadより古ければ、headのコミットを直接取ってレビュアーに読ませる', async () => {
  const { dir, headFile, git, remote, report, run, runWithLog } = await setup();
  assert.equal(await run('out1'), 0);
  // The cache already exists, so the new commit can only reach it through the fetch, not through the initial clone.
  await writeFile(join(dir, 'work', 'lib.js'), 'pushed\n');
  git('commit', '-qam', 'push');
  const pushed = git('rev-parse', 'HEAD');
  git('push', '-q', remote, 'HEAD:refs/heads/feature');
  await writeFile(headFile, pushed);
  const { code, stderr } = await runWithLog('out2');
  assert.equal(code, 0, stderr);
  assert.match(stderr, /headのコミットを直接取得します/);
  assert.equal(await readFile(report, 'utf8'), 'pushed\n');
  const manifest = JSON.parse(await readFile(join(dir, 'out2', 'manifest.json'), 'utf8'));
  assert.equal(manifest.repository.commit, pushed);
  await rm(dir, { recursive: true, force: true });
});

test('--prはPRのheadのコミットを取れなければ、レビュアーを起動せずに終了コード2で終わる', async () => {
  const { dir, headFile, run } = await setup();
  await writeFile(headFile, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(await run('out1'), 2);
  assert.deepEqual((await readdir(dir)).filter(name => name === 'out1' || name === 'report'), []);
  await rm(dir, { recursive: true, force: true });
});

test('--prは差分の取得までにPRのheadが変わったら、レビュアーを起動せずに終了コード2で終わる', async () => {
  const { dir, headFile, run } = await setup();
  await writeFile(`${headFile}2`, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(await run('out1'), 2);
  assert.deepEqual((await readdir(dir)).filter(name => name === 'out1' || name === 'report'), []);
  await rm(dir, { recursive: true, force: true });
});
