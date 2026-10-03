import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = new URL('../skills/review-team/scripts/run-reviewers.mjs', import.meta.url).pathname;

async function run(args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '意図', diff: '差分' }));
  const child = spawn(process.execPath, [runner, '--packet', join(dir, 'packet.json'), '--output', join(dir, 'out'), ...args],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: dir, ...env } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  return { dir, code, stderr };
}

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
    ['claude-1', 'claude', 'model-a', 'high', 'ok', 'claude-1.md'],
    ['claude-2', 'claude', 'model-b', 'max', 'ok', 'claude-2.md'],
  ]);
  assert.equal(await readFile(join(out, 'out', 'claude-1.md'), 'utf8'), 'model-a/high');
  assert.equal(await readFile(join(out, 'out', 'claude-2.md'), 'utf8'), 'model-b/max');
  await rm(dir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

for (const [spec, message] of [
  ['gemini:gemini-3', '未対応のCLIです'],
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

test('--helpは使い方を表示して正常終了する', async () => {
  const child = spawn(process.execPath, [runner, '--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
  assert.match(stdout, /--reviewer <cli>:<model>\[:<effort>\]/);
});
