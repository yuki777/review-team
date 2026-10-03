import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const runner = new URL('../skills/review-triple/scripts/run-reviewers.mjs', import.meta.url).pathname;

async function startWithHangingClis(extraArgs = []) {
  const dir = await mkdtemp(join(tmpdir(), 'review-triple-test-'));
  const pids = join(dir, 'pids');
  const cli = join(dir, 'hang');
  await writeFile(cli, `#!/bin/sh\n[ "$1" = --version ] && { echo fake 1; exit 0; }\n[ "$1" = inspect ] && exit 1\necho $$ >> "${pids}"\nexec sleep 60\n`);
  await chmod(cli, 0o755);
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '意図', diff: '差分' }));
  const child = spawn(process.execPath, [runner, '--packet', join(dir, 'packet.json'),
    '--output', join(dir, 'out'), ...extraArgs], {
    stdio: 'ignore',
    env: { ...process.env, TMPDIR: dir, REVIEW_TRIPLE_CLAUDE_CLI: cli,
      REVIEW_TRIPLE_CODEX_CLI: cli, REVIEW_TRIPLE_GROK_CLI: cli },
  });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { dir, pids, child, exited };
}

async function readPids(file, expected) {
  for (let i = 0; i < 100; i++) {
    const pids = (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
    if (pids.length >= expected) return pids;
    await sleep(50);
  }
  throw new Error('偽CLIが起動しませんでした。');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function assertCleanStop({ dir, pids, exited }, expectedStatus) {
  assert.equal(await exited, 1);
  const manifest = JSON.parse(await readFile(join(dir, 'out', 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.reviewers.map(r => [r.provider, r.status]),
    [['claude', expectedStatus], ['codex', expectedStatus], ['grok', 'sandbox_error']]);
  assert.deepEqual((await readPids(pids, 0)).filter(alive), []);
  assert.deepEqual((await readdir(dir)).filter(name => /^review-triple-/.test(name)), []);
  await rm(dir, { recursive: true, force: true });
}

test('端末終了（SIGHUP）で子CLIを残さず中断を記録する', async () => {
  const run = await startWithHangingClis();
  await readPids(run.pids, 2);
  run.child.kill('SIGHUP');
  await assertCleanStop(run, 'error');
});

test('制限時間を超えた子CLIを停止してtimeoutと記録する', async () => {
  const run = await startWithHangingClis(['--timeout', '1']);
  await assertCleanStop(run, 'timeout');
});

test('隔離を確認できないGrok CLIは起動しない', async () => {
  const run = await startWithHangingClis(['--timeout', '1']);
  await run.exited;
  const manifest = JSON.parse(await readFile(join(run.dir, 'out', 'manifest.json'), 'utf8'));
  const grok = manifest.reviewers.find(r => r.provider === 'grok');
  assert.equal(grok.exitCode, null);
  assert.equal((await readPids(run.pids, 0)).length, 2);
  await rm(run.dir, { recursive: true, force: true });
});
