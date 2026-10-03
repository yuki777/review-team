import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = new URL('../skills/review-team/scripts/run-reviewers.mjs', import.meta.url).pathname;

test('--repoは指定コミットの書き込み不可クローンを渡し、終了後と次回起動時に削除する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  const repo = join(dir, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'lib.js'), 'v1\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'lib.js'), 'v2\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two');

  const report = join(dir, 'report');
  const cli = join(dir, 'fake-claude');
  await writeFile(cli, `#!/bin/sh
[ "$1" = --version ] && { echo fake 1; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = --add-dir ] && clone="$2"; shift; done
{ echo "clone=$clone"; echo "content=$(cat "$clone/lib.js")"
  touch "$clone/canary" 2>/dev/null && echo writable=yes || echo writable=no; } > "${report}"
echo '{"type":"result","subtype":"success","is_error":false,"result":"指摘なし","modelUsage":{}}'
`);
  await chmod(cli, 0o755);
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '意図', diff: '差分' }));
  const state = join(dir, 'state');
  const stale = join(state, 'review-team', 'runs', 'run-stale');
  await mkdir(join(stale, 'src'), { recursive: true });
  await writeFile(join(stale, 'pid'), '999999');
  await writeFile(join(stale, 'src', 'old.js'), 'old\n');
  execFileSync('chmod', ['-R', 'a-w', join(stale, 'src')]);
  const objectModesBefore = await objectModes(repo);
  const child = spawn(process.execPath, [runner, '--packet', join(dir, 'packet.json'),
    '--output', join(dir, 'out'), '--repo', repo, '--ref', first, '--timeout', '30'], {
    stdio: 'ignore',
    env: { ...process.env, TMPDIR: dir, XDG_STATE_HOME: state,
      REVIEW_TEAM_CLAUDE_CLI: cli, REVIEW_TEAM_CODEX_CLI: '/nonexistent', REVIEW_TEAM_GROK_CLI: '/nonexistent' },
  });
  await new Promise(resolve => child.on('exit', resolve));

  const lines = Object.fromEntries((await readFile(report, 'utf8')).trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.match(lines.clone, new RegExp(`^${state}/review-team/runs/run-[^/]+/src$`));
  assert.equal(lines.content, 'v1');
  assert.equal(lines.writable, 'no');
  await assert.rejects(stat(lines.clone));
  assert.deepEqual(await readdir(join(state, 'review-team', 'runs')), []);
  assert.deepEqual(await objectModes(repo), objectModesBefore);

  const manifest = JSON.parse(await readFile(join(dir, 'out', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.repository, { path: await realpath(repo), ref: first, commit: first });
  assert.match(await readFile(join(dir, 'out', 'prompt.md'), 'utf8'), new RegExp(`コミット ${first}`));
  await rm(dir, { recursive: true, force: true });
});

async function objectModes(repo) {
  const objects = join(repo, '.git', 'objects');
  const files = (await readdir(objects, { recursive: true })).sort();
  return Promise.all(files.map(async file => [file, ((await stat(join(objects, file))).mode & 0o777).toString(8)]));
}

test('--refを解決できなければ起動前に拒否する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  execFileSync('git', ['init', '-q', join(dir, 'repo')]);
  await writeFile(join(dir, 'packet.json'), JSON.stringify({ intent: '意図', diff: '差分' }));
  const child = spawn(process.execPath, [runner, '--packet', join(dir, 'packet.json'),
    '--output', join(dir, 'out'), '--repo', join(dir, 'repo'), '--ref', 'no-such-ref'], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 2);
  await rm(dir, { recursive: true, force: true });
});
