import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pr1 = new URL('../skills/review-team/scripts/pr1', import.meta.url).pathname;
const baseQuery = 'is:pr state:open draft:false review-requested:@me status:success -author:app/renovate';

// 偽の gh は引数を1行ずつ記録し、渡された JSON を出力する。
async function run(args, json = '{"items":[]}') {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-pr1-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'gh.log');
  await writeFile(join(dir, 'out.json'), json);
  await writeFile(join(bin, 'gh'), `#!/bin/sh
for arg; do echo "$arg" >> "${log}"; done
cat "${join(dir, 'out.json')}"
`);
  await chmod(join(bin, 'gh'), 0o755);
  const child = spawn('bash', [pr1, ...args], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  const argv = await readFile(log, 'utf8').then(text => text.trimEnd().split('\n'), () => null);
  await rm(dir, { recursive: true, force: true });
  return { code, stdout, stderr, argv };
}

test('基本の検索条件に -q の条件を書いた順に足して検索する', async () => {
  const { code, argv } = await run([]);
  assert.equal(code, 0);
  assert.deepEqual(argv, ['api', '-X', 'GET', 'search/issues', '-f', `q=${baseQuery}`,
    '-f', 'sort=updated', '-f', 'order=desc', '-F', 'per_page=1']);
  const more = await run(['-q', 'org:acme', '--query', 'repo:acme/widget']);
  assert.equal(more.argv[5], `q=${baseQuery} org:acme repo:acme/widget`);
});

test('見つかった PR の URL を出力する', async () => {
  const { code, stdout } = await run([], '{"items":[{"html_url":"https://example.test/acme/widget/pull/7"}]}');
  assert.equal(code, 0);
  assert.equal(stdout, 'https://example.test/acme/widget/pull/7\n');
});

test('該当が無ければ何も出力せずに成功で終わる', async () => {
  const { code, stdout } = await run([]);
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('-q の値が無いときと不明なオプションは、検索せずに終了コード2で終わる', async () => {
  for (const args of [['-q'], ['--query', ''], ['--bogus']]) {
    const { code, stderr, argv } = await run(args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, /^pr1: /, args.join(' '));
    assert.equal(argv, null, args.join(' '));
  }
});
