import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillDir = new URL('../skills/review-team', import.meta.url).pathname;

test('manifestにreview-teamの版を記録する。自分のチェックアウトならgit describe、それ以外はVERSIONを使う', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
echo '{"type":"result","subtype":"success","is_error":false,"result":"指摘なし","modelUsage":{}}'
`);
  await chmod(cli, 0o755);
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '意図', diff: '差分' }));

  const copied = join(dir, 'copied');
  await cp(skillDir, copied, { recursive: true });
  const otherRepo = join(dir, 'other');
  await mkdir(otherRepo);
  execFileSync('git', ['init', '-q', otherRepo]);
  await cp(skillDir, join(otherRepo, 'vendor', 'review-team'), { recursive: true });
  await cp(skillDir, join(otherRepo, 'skills', 'review-team'), { recursive: true });
  await symlink(skillDir, join(dir, 'linked'));
  execFileSync('git', ['-C', otherRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', otherRepo, 'tag', 'v9.9.9']);

  const versionOf = async (skill, output, env = {}) => {
    const child = spawn(process.execPath, [join(skill, 'scripts', 'run-reviewers.mjs'), '--packet', join(dir, 'packet.json'),
      '--output', join(dir, output), '--reviewer', 'claude:m'], {
      stdio: 'ignore', env: { ...process.env, TMPDIR: dir, REVIEW_TEAM_CLAUDE_CLI: cli, GIT_CEILING_DIRECTORIES: dir, ...env },
    });
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
    return JSON.parse(await readFile(join(dir, output, 'manifest.json'), 'utf8')).reviewTeamVersion;
  };

  const fileVersion = `v${(await readFile(join(skillDir, 'VERSION'), 'utf8')).trim()}`;
  const described = execFileSync('git', ['-C', skillDir, 'describe', '--tags', '--always', '--dirty'], { encoding: 'utf8' }).trim();
  assert.equal(await versionOf(skillDir, 'own'), described);
  assert.equal(await versionOf(join(dir, 'linked'), 'linked-out'), described);
  assert.equal(await versionOf(skillDir, 'no-git', { PATH: '/nonexistent' }), fileVersion);
  assert.equal(await versionOf(copied, 'copied-out'), fileVersion);
  assert.equal(await versionOf(join(otherRepo, 'vendor', 'review-team'), 'vendored-out'), fileVersion);
  assert.equal(await versionOf(join(otherRepo, 'skills', 'review-team'), 'same-layout-out'), fileVersion);
  await rm(dir, { recursive: true, force: true });
});
