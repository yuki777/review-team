import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = new URL('../skills/review-team/scripts/review-team', import.meta.url).pathname;
const reviewersJson = new URL('../skills/review-team/config/reviewers.json', import.meta.url).pathname;
const prUrl = 'https://example.test/acme/widget/pull/7';

// The fake claude records its working directory and arguments, one argument per line.
async function run(args) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-wrapper-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'claude.log');
  await writeFile(join(bin, 'claude'), `#!/bin/sh
pwd > "${log}"
for arg; do echo "$arg" >> "${log}"; done
`);
  await chmod(join(bin, 'claude'), 0o755);
  const child = spawn('bash', [wrapper, ...args], { stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state') } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  const lines = await readFile(log, 'utf8').then(text => text.trimEnd().split('\n'), () => null);
  return { dir, code, stderr, cwd: lines?.[0], argv: lines ? lines.slice(1) : null };
}

const prompt = reviewers => `/review-team --comment --watch${reviewers.map(r => ` --reviewer ${r}`).join('')} ${prUrl}`;

test('チームを省略すると、状態ディレクトリで既定のレビュアーのまま起動する', async () => {
  const { dir, code, cwd, argv } = await run([prUrl]);
  assert.equal(code, 0);
  assert.equal(cwd, join(dir, 'state', 'review-team'));
  assert.deepEqual(argv, ['--effort', 'xhigh', '--permission-mode', 'auto', prompt([])]);
});

test('チーム名はメンバー名を-でつないだもので、書いた順にレビュアーを並べる', async () => {
  const cases = {
    'opus-sol': ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high'],
    'sol-opus': ['codex:gpt-6.1-sol:high', 'claude:claude-opus-5-5:high'],
    'opus-sol-grok-argon': ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high',
      'grok:grok-4.7-build-fast:high', 'agy:gemini-4-argon-high:high'],
    'fable-astra': ['claude:claude-fable-5-1:high', 'codex:gpt-6-astra:high'],
  };
  for (const [team, reviewers] of Object.entries(cases)) {
    for (const args of [['--team', team, prUrl], [`--team=${team}`, prUrl], [prUrl, '--team', team]]) {
      const { code, argv } = await run(args);
      assert.equal(code, 0, args.join(' '));
      assert.equal(argv.at(-1), prompt(reviewers), args.join(' '));
    }
  }
});

test('opus-sol-grok-argonはconfig/reviewers.jsonの既定と同じ4人になる', async () => {
  const defaults = JSON.parse(await readFile(reviewersJson, 'utf8')).reviewers
    .map(({ cli, model, effort }) => `${cli}:${model}:${effort}`);
  const { argv } = await run(['--team', 'opus-sol-grok-argon', prUrl]);
  assert.equal(argv.at(-1), prompt(defaults));
});

test('不明なメンバー・重複・空のメンバー・引数の誤りは、claudeを起動せずに終了コード1で止まる', async () => {
  for (const args of [
    ['--team', 'opus-gemini', prUrl], ['--team', 'opus-opus', prUrl], ['--team', 'opus--sol', prUrl], ['--team', '-opus', prUrl],
    ['--team', 'opus-*', prUrl], ['--team', 'opus', 'sol', prUrl], ['opus-sol', prUrl, prUrl], ['--team'], ['--effort', 'max', prUrl], [],
  ]) {
    const { code, argv } = await run(args);
    assert.equal(code, 1, args.join(' '));
    assert.equal(argv, null, args.join(' '));
  }
});

test('--helpは使い方を出して終了コード0で終わる', async () => {
  const { code, stderr, argv } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stderr, /usage: review-team/);
  assert.equal(argv, null);
});
