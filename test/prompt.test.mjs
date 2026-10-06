import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('packetだけのレビューでは、upstreamのテンプレートに4つの値を埋め、リポジトリの節を付けない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  assert.equal(await runPacketOnly(skillDir, dir, 'out'), 0);
  const prompt = await readFile(join(dir, 'out', 'prompt.md'), 'utf8');
  assert.ok(prompt.startsWith('You are an adversarial code reviewer.'));
  assert.ok(prompt.includes('> keep $& and {INTENT} as typed'), 'the intent is inserted literally');
  assert.ok(prompt.includes('"diff": "+const x = 1;\\n"'));
  assert.ok(prompt.includes(await readFile(join(references, 'rubric.md'), 'utf8')));
  assert.ok(prompt.includes(await readFile(join(references, 'code-quality-review.md'), 'utf8')));
  assert.doesNotMatch(prompt, /\{(DIFF_OR_FILES|RUBRIC_CONTENTS|CODE_QUALITY_CONTENTS)\}/);
  assert.ok(!prompt.includes('## Reference Repository'));
  await rm(dir, { recursive: true, force: true });
});

test('reviewer-prompt.mdに区切りの---が無ければ起動前に止める', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const copied = join(dir, 'skill');
  await cp(skillDir, copied, { recursive: true });
  await writeFile(join(copied, 'references', 'reviewer-prompt.md'), 'You are a reviewer.\n\n{INTENT}\n');
  assert.equal(await runPacketOnly(copied, dir, 'out'), 2);
  await rm(dir, { recursive: true, force: true });
});
