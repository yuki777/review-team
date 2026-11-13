import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillDir = new URL('../skills/review-team', import.meta.url).pathname;
const references = join(skillDir, 'references');

async function runPacketOnly(skill, dir, output) {
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
echo '{"type":"result","subtype":"success","is_error":false,"result":"no findings","modelUsage":{}}'
`);
  await chmod(cli, 0o755);
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: 'keep $& and {INTENT} as typed', diff: '+const x = 1;\n' }));
  const child = spawn(process.execPath, [join(skill, 'scripts', 'run-reviewers.mjs'), '--packet', join(dir, 'packet.json'),
    '--output', join(dir, output), '--reviewer', 'claude:m'], {
    stdio: 'ignore', env: { ...process.env, TMPDIR: dir, REVIEW_TEAM_CLAUDE_CLI: cli },
  });
  return new Promise(resolve => child.on('exit', resolve));
}

test('packetだけのレビューでは、テンプレートに意図と差分を埋め、リポジトリの節を付けない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  assert.equal(await runPacketOnly(skillDir, dir, 'out'), 0);
  const prompt = await readFile(join(dir, 'out', 'prompt.md'), 'utf8');
  assert.ok(prompt.startsWith('You are an adversary. Break this change.'));
  assert.ok(prompt.includes('> keep $& and {INTENT} as typed'), 'the intent is inserted literally');
  assert.ok(prompt.includes('"diff": "+const x = 1;\\n"'));
  assert.ok(prompt.includes('Prove each finding with a run'));
  assert.doesNotMatch(prompt, /\{DIFF_OR_FILES\}/);
  assert.ok(!prompt.includes('## Reference Repository'));
  await assert.rejects(stat(join(dir, 'out', 'reviewed.diff')), { code: 'ENOENT' }, 'reviewed.diff is written only for --pr');
  await rm(dir, { recursive: true, force: true });
});
