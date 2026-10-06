import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = new URL('../skills/review-team/scripts/run-reviewers.mjs', import.meta.url).pathname;

test('--prはリポジトリをキャッシュにクローンし、PRのheadを読ませ、資料をPRから補う', async () => {
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

  const bin = join(dir, 'bin');
  await mkdir(bin);
  const ghLog = join(dir, 'gh.log');
  await writeFile(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$1 $2" in
  "pr view") echo '{"number":7,"url":"https://example.test/acme/widget/pull/7","title":"PRのタイトル","body":"PRの本文","baseRefName":"main"}' ;;
  "pr diff") printf 'diff --git a/lib.js b/lib.js\\n-base\\n+pr-head\\n' ;;
  "repo clone") git clone -q --no-checkout "${remote}" "$4" ;;
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
  const run = async (output, extraArgs = []) => {
    const child = spawn(process.execPath, [runner, '--pr', '7', '--output', join(dir, output), '--reviewer', 'claude:m', ...extraArgs], {
      stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, XDG_STATE_HOME: state, REVIEW_TEAM_CLAUDE_CLI: cli },
    });
    return new Promise(resolve => child.on('exit', resolve));
  };

  assert.equal(await run('out1'), 0);
  assert.equal(await run('out2'), 0);
  assert.equal(await readFile(report, 'utf8'), 'pr-head\n');
  const cache = join(state, 'review-team', 'repos', 'example.test', 'acme', 'widget');
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
  await rm(dir, { recursive: true, force: true });
});

test('--prと--repoは同時に指定できない', async () => {
  const child = spawn(process.execPath, [runner, '--pr', '1', '--repo', '.', '--output', join(tmpdir(), 'unused')], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 2);
});
