import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = new URL('../skills/review-team/scripts/rt', import.meta.url).pathname;
const reviewersJson = new URL('../skills/review-team/config/reviewers.json', import.meta.url).pathname;
const skillDir = new URL('../skills/review-team', import.meta.url).pathname;
const versionFile = new URL('../skills/review-team/VERSION', import.meta.url).pathname;
const prUrl = 'https://example.test/acme/widget/pull/7';

// The fake claude records its working directory and arguments, one argument per line.
// command を渡すと、bash を通さずにそのパス（シンボリックリンクなど）を直接実行する。
async function run(args, command) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-wrapper-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'claude.log');
  await writeFile(join(bin, 'claude'), `#!/bin/sh
pwd > "${log}"
for arg; do echo "$arg" >> "${log}"; done
`);
  await chmod(join(bin, 'claude'), 0o755);
  const child = spawn(command ?? 'bash', command ? args : [wrapper, ...args], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state') } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  const lines = await readFile(log, 'utf8').then(text => text.trimEnd().split('\n'), () => null);
  return { dir, code, stdout, stderr, cwd: lines?.[0], argv: lines ? lines.slice(1) : null };
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
    'opus-fable-sol': ['claude:claude-opus-5-5:high', 'claude:claude-fable-5-2:high', 'codex:gpt-6.1-sol:high'],
    'fable-astra': ['claude:claude-fable-5-2:high', 'codex:gpt-6-astra:high'],
    'opus:max-sol:ultra-astra:low': ['claude:claude-opus-5-5:max', 'codex:gpt-6.1-sol:ultra', 'codex:gpt-6-astra:low'],
  };
  for (const [team, reviewers] of Object.entries(cases)) {
    for (const args of [['--team', team, prUrl], [`--team=${team}`, prUrl], [prUrl, '--team', team]]) {
      const { code, argv } = await run(args);
      assert.equal(code, 0, args.join(' '));
      assert.equal(argv.at(-1), prompt(reviewers), args.join(' '));
    }
  }
});

test('opus:xhigh-astra:xhighはconfig/reviewers.jsonの既定と同じ2人になる', async () => {
  const defaults = JSON.parse(await readFile(reviewersJson, 'utf8')).reviewers
    .map(({ cli, model, effort }) => `${cli}:${model}:${effort}`);
  const { argv } = await run(['--team', 'opus:xhigh-astra:xhigh', prUrl]);
  assert.equal(argv.at(-1), prompt(defaults));
});

test('--with-considerを付けたときだけ--with-considerを渡す', async () => {
  for (const [args, post] of [[[prUrl], ''], [['--with-consider', prUrl], ' --with-consider'],
    [[prUrl, '--with-consider', '--team', 'opus'], ' --with-consider']]) {
    const { code, argv } = await run(args);
    assert.equal(code, 0, args.join(' '));
    const reviewers = args.includes('--team') ? ' --reviewer claude:claude-opus-5-5:high' : '';
    assert.equal(argv.at(-1), `/review-team --comment --watch${post}${reviewers} ${prUrl}`, args.join(' '));
  }
});

test('--printはclaude -pで起動し、ほかの引数は変えない', async () => {
  for (const args of [['--print', prUrl], [prUrl, '--print', '--team', 'opus']]) {
    const { code, argv } = await run(args);
    assert.equal(code, 0, args.join(' '));
    const reviewers = args.includes('--team') ? ' --reviewer claude:claude-opus-5-5:high' : '';
    assert.deepEqual(argv, ['-p', '--effort', 'xhigh', '--permission-mode', 'auto',
      `/review-team --comment --watch${reviewers} ${prUrl}`], args.join(' '));
  }
});

test('不明なメンバー・重複・空のメンバー・使えないeffort・引数の誤りは、claudeを起動せずに終了コード1で止まる', async () => {
  for (const args of [
    ['--team', 'opus-gemini', prUrl], ['--team', 'opus-opus', prUrl], ['--team', 'opus--sol', prUrl], ['--team', '-opus', prUrl],
    ['--team', 'opus-*', prUrl],
    ['--team', 'opus:ultra', prUrl], ['--team', 'grok-opus', prUrl], ['--team', 'opus:bogus', prUrl], ['--team', 'opus:', prUrl],
    ['--team', 'opus:max:x', prUrl], ['--team', ':high', prUrl], ['--team', 'opus:max-opus', prUrl], ['--team', 'opus', 'sol', prUrl], ['opus-sol', prUrl, prUrl], ['--team'], ['--effort', 'max', prUrl], [],
    ['--act-on-only', prUrl],
  ]) {
    const { code, argv } = await run(args);
    assert.equal(code, 1, args.join(' '));
    assert.equal(argv, null, args.join(' '));
  }
});

test('--helpは使い方を出して終了コード0で終わる', async () => {
  const { code, stdout, argv } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /使い方:\n  rt /);
  assert.equal(argv, null);
});

test('引数の誤りは、エラーと--helpの案内だけを標準エラーに出して終了コード1で終わる', async () => {
  for (const [args, message] of [[[], 'PR の URL を指定してください'], [['--bogus'], '不明なオプションです: --bogus']]) {
    const { code, stdout, stderr, argv } = await run(args);
    assert.equal(code, 1, args.join(' '));
    assert.equal(stdout, '');
    assert.equal(stderr, `rt: ${message}\n詳しくは rt --help\n`);
    assert.equal(argv, null);
  }
});

test('--versionはVERSIONの版を標準出力に出して終了コード0で終わり、使い方にも版が出る', async () => {
  const expected = `rt v${(await readFile(versionFile, 'utf8')).trim()}`;
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `${expected}\n`);
  assert.equal(version.argv, null);
  const help = await run(['--help']);
  assert.equal(help.stdout.split('\n')[0], expected);
});

test('シンボリックリンク経由で実行しても、実体の隣のVERSIONを読む', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-link-'));
  await symlink(skillDir, join(dir, 'skill'));
  await mkdir(join(dir, 'bin'));
  // 絶対パスと相対パスのリンクを2段たどる: bin/rt -> <dir>/bin/link -> ../skill/scripts/rt
  await symlink(join('..', 'skill', 'scripts', 'rt'), join(dir, 'bin', 'link'));
  await symlink(join(dir, 'bin', 'link'), join(dir, 'bin', 'rt'));
  const { code, stdout } = await run(['--version'], join(dir, 'bin', 'rt'));
  assert.equal(code, 0);
  assert.equal(stdout, `rt v${(await readFile(versionFile, 'utf8')).trim()}\n`);
});

// The fake node records each scan it is started with, and the fake sleep records its seconds and stops the loop.
async function loop(args) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-loop-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'node'), `#!/bin/sh\necho "$*" >> "${join(dir, 'node.log')}"\nexit 2\n`);
  await writeFile(join(bin, 'sleep'), `#!/bin/sh\necho "$1" >> "${join(dir, 'sleep.log')}"\nkill $PPID\n`);
  await writeFile(join(bin, 'claude'), `#!/bin/sh\ntouch "${join(dir, 'claude.log')}"\n`);
  for (const name of ['node', 'sleep', 'claude']) await chmod(join(bin, name), 0o755);
  const child = spawn('bash', [wrapper, ...args], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state') } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve(exitCode ?? signal)));
  const read = name => readFile(join(dir, name), 'utf8').then(text => text.trimEnd().split('\n'), () => []);
  return { code, stderr, scans: await read('node.log'), sleeps: await read('sleep.log'), claude: (await read('claude.log')).length > 0 };
}

const scanner = new URL('../skills/review-team/scripts/scan-prs.mjs', import.meta.url).pathname;

test('--loopはscanに組織・リポジトリ・チーム・--with-considerを渡し、scanが失敗しても待ってから繰り返す', async () => {
  const { code, scans, sleeps, claude } = await loop(['--loop', '--org', 'acme', '--repo', 'widget',
    '--repo', 'gadget.js', '--team', 'opus:xhigh-sol', '--with-consider']);
  assert.equal(code, 'SIGTERM');
  assert.deepEqual(scans, [`${scanner} scan --org acme --repo widget --repo gadget.js --team opus:xhigh-sol --with-consider`]);
  assert.deepEqual(sleeps, ['900']);
  assert.equal(claude, false);
  const plain = await loop(['--loop', '--org', 'acme', '--interval', '30']);
  assert.deepEqual(plain.scans, [`${scanner} scan --org acme`]);
  assert.deepEqual(plain.sleeps, ['1800']);
});

test('--loopの引数の誤りは、scanを起動せずに終了コード1で止まる', async () => {
  for (const args of [
    ['--loop'], ['--loop', '--org', 'acme', prUrl], ['--loop', '--org', 'acme', '--print'],
    ['--loop', '--org', 'acme', '--interval', '0'], ['--loop', '--org', 'acme', '--interval', '08'],
    ['--loop', '--org', 'acme', '--interval', '1m'], ['--loop', '--org', 'acme', '--interval'],
    ['--loop', '--org', 'acme', '--team', 'opus-nope'], ['--org', 'acme', prUrl], ['--repo', 'widget', prUrl], ['--interval', '5', prUrl],
    ['--loop', '--org', 'acme', '--repo', 'acme/widget'], ['--loop', '--org', 'acme', '--repo', 'a b'], ['--loop', '--org', 'acme', '--repo', '*'],
  ]) {
    const { code, scans, sleeps, claude } = await loop(args);
    assert.equal(code, 1, args.join(' '));
    assert.deepEqual([scans, sleeps, claude], [[], [], false], args.join(' '));
  }
});
