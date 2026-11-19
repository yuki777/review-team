import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = new URL('../skills/review-team/scripts/run-reviewers.mjs', import.meta.url).pathname;

// The user's config directory is always a temporary one, so a developer's own config.json never reaches a test.
async function run(args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '意図', diff: '差分' }));
  const child = spawn(process.execPath, [runner, '--packet', join(dir, 'packet.json'), '--output', join(dir, 'out'), ...args],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: dir, XDG_CONFIG_HOME: join(dir, 'config'), ...env } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  return { dir, code, stderr };
}

// Runs --list-reviewers with the given config.json (none when config is undefined; a string is written as it is).
async function list(config, args = []) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  if (config !== undefined) {
    await mkdir(join(dir, 'review-team'));
    await writeFile(join(dir, 'review-team', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  const child = spawn(process.execPath, [runner, '--list-reviewers', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: dir } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  await rm(dir, { recursive: true, force: true });
  return { code, stdout, stderr, file: join(dir, 'review-team', 'config.json') };
}

test('レビュアーの本文はreviewer-<ID>.mdに書き、Claude Codeの指示ファイルCLAUDE.mdと名前が重ならない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
echo '{"type":"result","subtype":"success","is_error":false,"result":"no findings","modelUsage":{}}'
`);
  await chmod(cli, 0o755);
  const { dir: out, code } = await run(['--reviewer', 'claude:m'], { REVIEW_TEAM_CLAUDE_CLI: cli });
  assert.equal(code, 0);
  assert.equal(await readFile(join(out, 'out', 'reviewer-claude.md'), 'utf8'), 'no findings');
  // macOS file systems are usually case-insensitive, so claude.md would be read as CLAUDE.md.
  assert.ok(!(await readdir(join(out, 'out'))).some(name => name.toLowerCase() === 'claude.md'));
  await rm(dir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('同じCLIを複数指定すると連番IDで別々に実行し、それぞれのモデルとeffortを渡す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --effort) e="$2";; esac; shift; done
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$m/$e\\",\\"modelUsage\\":{\\"$m\\":{}}}"
`);
  await chmod(cli, 0o755);
  const { dir: out, code } = await run(
    ['--reviewer', 'claude:model-a', '--reviewer', 'claude:model-b:max'], { REVIEW_TEAM_CLAUDE_CLI: cli });
  assert.equal(code, 0);
  const manifest = JSON.parse(await readFile(join(out, 'out', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.reviewers.map(r => [r.id, r.cli, r.requestedModel, r.requestedEffort, r.status, r.outputFile]), [
    ['claude-1', 'claude', 'model-a', 'high', 'ok', 'reviewer-claude-1.md'],
    ['claude-2', 'claude', 'model-b', 'max', 'ok', 'reviewer-claude-2.md'],
  ]);
  assert.equal(await readFile(join(out, 'out', 'reviewer-claude-1.md'), 'utf8'), 'model-a/high');
  assert.equal(await readFile(join(out, 'out', 'reviewer-claude-2.md'), 'utf8'), 'model-b/max');
  await rm(dir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

for (const [spec, message] of [
  ['gemini:gemini-3', '未対応のCLIです'],
  ['grok:grok-4.7', '未対応のCLIです'],
  ['claude', 'モデルIDが不正です'],
  ['claude:a:high:extra', '<cli>:<model>[:<effort>]'],
  ['codex:gpt;rm', 'モデルIDが不正です'],
]) {
  test(`不正な--reviewer指定は起動前に拒否する: ${spec}`, async () => {
    const { dir, code, stderr } = await run(['--reviewer', spec]);
    assert.equal(code, 2);
    assert.match(stderr, new RegExp(message.replace(/[[\]<>]/g, '\\$&')));
    await rm(dir, { recursive: true, force: true });
  });
}

test('既定のレビュアーは、設定ファイルのreviewersがあればそれ、無ければスキル同梱のconfig/default.jsonになる', async () => {
  const builtin = JSON.parse(await readFile(new URL('../skills/review-team/config/default.json', import.meta.url), 'utf8')).reviewers
    .map(({ cli, model, effort }) => `${cli}:${model}:${effort}\n`).join('');
  assert.deepEqual(await list().then(({ code, stdout }) => [code, stdout]), [0, builtin]);
  // loop だけの設定ファイルでは、レビュアーは変わらない。
  assert.deepEqual(await list({ loop: { org: 'acme' } }).then(({ code, stdout }) => [code, stdout]), [0, builtin]);
  const config = { reviewers: [{ cli: 'claude', model: 'model-a', effort: 'max' }, { cli: 'codex', model: 'model-b' }] };
  assert.deepEqual(await list(config).then(({ code, stdout }) => [code, stdout]), [0, 'claude:model-a:max\ncodex:model-b:high\n']);
});

test('--reviewerは設定ファイルのreviewersを丸ごと置き換え、設定ファイルが壊れていても読まない', async () => {
  for (const config of [{ reviewers: [{ cli: 'claude', model: 'model-a' }] }, '{']) {
    const { code, stdout } = await list(config, ['--reviewer', 'codex:model-c:low']);
    assert.deepEqual([code, stdout], [0, 'codex:model-c:low\n']);
  }
});

test('設定ファイルのレビュアーでレビューを実行する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --effort) e="$2";; esac; shift; done
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$m/$e\\",\\"modelUsage\\":{}}"
`);
  await chmod(cli, 0o755);
  await mkdir(join(dir, 'review-team'));
  await writeFile(join(dir, 'review-team', 'config.json'), JSON.stringify({ reviewers: [{ cli: 'claude', model: 'model-a', effort: 'max' }] }));
  const { dir: out, code } = await run([], { REVIEW_TEAM_CLAUDE_CLI: cli, XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  assert.equal(await readFile(join(out, 'out', 'reviewer-claude.md'), 'utf8'), 'model-a/max');
  await rm(dir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('設定ファイルに誤りがあれば、レビューを始めず、出力先も作らずに終了コード2で終わる', async () => {
  const config = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  await mkdir(join(config, 'review-team'));
  await writeFile(join(config, 'review-team', 'config.json'), JSON.stringify({ reviewer: [] }));
  const { dir, code, stderr } = await run([], { XDG_CONFIG_HOME: config });
  assert.equal(code, 2);
  assert.match(stderr, /^設定ファイルに誤りがあります: /);
  assert.ok(!(await readdir(dir)).includes('out'));
  await rm(config, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

for (const [config, message] of [
  ['{', 'JSON'],
  [[], '全体を JSON のオブジェクトにしてください'],
  [{ reviewer: [] }, '知らないキーです: reviewer'],
  [{ reviewers: [] }, 'reviewers は'],
  [{ reviewers: null }, 'reviewers は'],
  [{ reviewers: [{ cli: 'gemini', model: 'm' }] }, '未対応のCLIです: gemini'],
  [{ reviewers: [{ cli: 'claude', model: 'm', efort: 'max' }] }, '知らないキーです: reviewers[].efort'],
  [{ reviewers: [{ cli: 'codex', model: 'gpt;rm' }] }, 'モデルIDが不正です'],
  [{ loop: [] }, 'loop はオブジェクトにしてください'],
  [{ loop: { interval: 10, team: 'opus' } }, '知らないキーです: loop.team'],
  [{ loop: { org: 'acme', repos: ['acme/widget'] } }, 'どちらか一方だけ'],
  [{ loop: { org: 'acme widget' } }, 'loop.org は'],
  [{ loop: { repos: 'acme/widget' } }, 'loop.repos は'],
  [{ loop: { repos: [] } }, 'loop.repos は'],
  [{ loop: { repos: ['widget'] } }, 'loop.repos は'],
  [{ loop: { repos: ['-a/b'] } }, 'loop.repos は'],
  [{ loop: { repos: ['a/*'] } }, 'loop.repos は'],
  [{ loop: { interval: 0 } }, 'loop.interval は'],
  [{ loop: { interval: '10' } }, 'loop.interval は'],
  [{ loop: { interval: 1.5 } }, 'loop.interval は'],
]) {
  test(`誤りのある設定ファイルは、パスを添えて終了コード2で拒否する: ${JSON.stringify(config)}`, async () => {
    const { code, stdout, stderr, file } = await list(config);
    assert.deepEqual([code, stdout], [2, '']);
    assert.ok(stderr.startsWith(`設定ファイルに誤りがあります: ${file}（`), stderr);
    assert.ok(stderr.includes(message), stderr);
  });
}

test('--helpは使い方を表示して正常終了する', async () => {
  const child = spawn(process.execPath, [runner, '--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
  assert.match(stdout, /--reviewer <cli>:<model>\[:<effort>\]/);
});
