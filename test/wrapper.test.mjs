import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = new URL('../skills/review-team/scripts/rt', import.meta.url).pathname;
const reviewersJson = new URL('../skills/review-team/config/reviewers.json', import.meta.url).pathname;
const skillDir = new URL('../skills/review-team', import.meta.url).pathname;
const versionFile = new URL('../skills/review-team/VERSION', import.meta.url).pathname;
const prUrl = 'https://example.test/acme/widget/pull/7';

// The fake claude records its working directory and arguments, one argument per line, and the lock it was given.
// The fake gh answers rt's question about the PR with the head in <dir>/head (aaa if missing), or fails with gh-fails.
// It answers the latest release with <dir>/latest, or with the current VERSION when that file is missing, and fails it with latest-fails.
// command を渡すと、bash を通さずにそのパス（シンボリックリンクなど）を直接実行する。dir を渡すと、その状態で続けて実行する。
async function setup(dir) {
  dir ??= await mkdtemp(join(tmpdir(), 'review-team-wrapper-'));
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude'), `#!/bin/sh
echo "$$ $REVIEW_TEAM_PR_LOCK" >> "${join(dir, 'claude.pids')}"
[ -f "${join(dir, 'claude-hangs')}" ] && sleep 30
pwd > "${join(dir, 'claude.log')}"
for arg; do echo "$arg" >> "${join(dir, 'claude.log')}"; done
`);
  await writeFile(join(bin, 'gh'), `#!/bin/sh
[ -f "${join(dir, 'gh-fails')}" ] && { echo 'gh: network down' >&2; exit 1; }
[ "$1 $2" = "api repos/yuki777/review-team/releases/latest" ] && [ -f "${join(dir, 'latest-fails')}" ] && exit 1
[ "$1 $2" = "api repos/yuki777/review-team/releases/latest" ] && { cat "${join(dir, 'latest')}" 2>/dev/null || echo "v$(cat "${versionFile}")"; exit 0; }
head=$(cat "${join(dir, 'head')}" 2>/dev/null || echo aaa)
printf '{"data":{"resource":{"url":"${prUrl}","state":"OPEN","isDraft":false,"headRefOid":"%s"}}}' "$head"
`);
  await chmod(join(bin, 'claude'), 0o755);
  await chmod(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'state') };
  delete env.REVIEW_TEAM_PR_LOCK;
  return { dir, env };
}

function start(args, { dir, env }, command) {
  const child = spawn(command ?? 'bash', command ? args : [wrapper, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = (async () => {
    const code = await new Promise(resolve => child.on('exit', resolve));
    const lines = await readFile(join(dir, 'claude.log'), 'utf8').then(text => text.trimEnd().split('\n'), () => null);
    return { dir, code, stdout, stderr, cwd: lines?.[0], argv: lines ? lines.slice(1) : null };
  })();
  return { child, done };
}

async function run(args, command, dir) {
  return start(args, await setup(dir), command).done;
}

const prompt = reviewers => `/review-team --comment --watch${reviewers.map(r => ` --reviewer ${r}`).join('')} ${prUrl}`;

test('チームを省略すると、状態ディレクトリで既定のレビュアーのまま起動する', async () => {
  const { dir, code, cwd, argv } = await run([prUrl]);
  assert.equal(code, 0);
  assert.equal(cwd, join(dir, 'state', 'review-team'));
  assert.deepEqual(argv, ['--model', 'claude-opus-5-5', '--effort', 'xhigh', '--permission-mode', 'auto', prompt([])]);
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

test('fable:xhigh-astra:xhighはconfig/reviewers.jsonの既定と同じ2人になる', async () => {
  const defaults = JSON.parse(await readFile(reviewersJson, 'utf8')).reviewers
    .map(({ cli, model, effort }) => `${cli}:${model}:${effort}`);
  const { argv } = await run(['--team', 'fable:xhigh-astra:xhigh', prUrl]);
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
    assert.deepEqual(argv, ['-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--permission-mode', 'auto',
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

const prState = dir => join(dir, 'state', 'review-team', 'watch', 'prs', 'example.test', 'acme', 'widget', '7.json');
const readJson = file => readFile(file, 'utf8').then(JSON.parse);
const waitFor = async check => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('待ちきれません');
};
// A pid that is certainly not running: a child that has already exited.
const deadPid = async () => {
  const child = spawn('true');
  await new Promise(done => child.on('exit', done));
  return child.pid;
};

test('claudeにはPRのロックを渡し、開始をheadごとに数える', async () => {
  const { dir, code } = await run([prUrl]);
  assert.equal(code, 0);
  const [pid, token] = (await readFile(join(dir, 'claude.pids'), 'utf8')).trim().split(' ');
  // exec keeps the shell's pid, so the lock names claude itself.
  assert.equal(token, pid);
  assert.equal(await readFile(`${prState(dir)}.lock`, 'utf8'), pid);
  assert.deepEqual(await readJson(`${prState(dir)}.reviewed`), { attemptHead: 'aaa', attempts: 1 });
  await run([prUrl], undefined, dir);
  assert.equal((await readJson(`${prState(dir)}.reviewed`)).attempts, 2);
  await writeFile(join(dir, 'head'), 'bbb');
  await run([prUrl], undefined, dir);
  assert.deepEqual(await readJson(`${prState(dir)}.reviewed`), { attemptHead: 'bbb', attempts: 1 });
});

test('レビュー済みのheadはclaudeを起動せずに終了コード0で見送り、--forceか新しいheadならレビューする', async () => {
  const { dir } = await setup();
  await mkdir(join(prState(dir), '..'), { recursive: true });
  await writeFile(`${prState(dir)}.reviewed`, JSON.stringify({ completedHead: 'aaa' }));
  const skipped = await run([prUrl], undefined, dir);
  assert.equal(skipped.code, 0);
  assert.equal(skipped.argv, null);
  assert.match(skipped.stdout, /head aaa はレビュー済みなので見送ります（やり直すには --force）/);
  // The lock taken to check is given back, so the PR does not look busy.
  await assert.rejects(readFile(`${prState(dir)}.lock`));
  const forced = await run(['--force', prUrl], undefined, dir);
  assert.equal(forced.code, 0);
  assert.equal(forced.argv.at(-1), prompt([]));
  await rm(join(dir, 'claude.log'));
  await writeFile(join(dir, 'head'), 'bbb');
  assert.notEqual((await run([prUrl], undefined, dir)).argv, null);
});

test('同じPRを同時に起動すると、2本目はclaudeを起動せずに終了コード0で見送る', async () => {
  const ctx = await setup();
  await writeFile(join(ctx.dir, 'claude-hangs'), '');
  const first = start([prUrl], ctx);
  await waitFor(() => readFile(join(ctx.dir, 'claude.pids'), 'utf8').catch(() => ''));
  const second = await start([prUrl], ctx).done;
  assert.equal(second.code, 0);
  assert.match(second.stdout, /同じPRのレビューが実行中なので見送ります/);
  first.child.kill('SIGKILL');
  await first.done;
  assert.equal((await readFile(join(ctx.dir, 'claude.pids'), 'utf8')).trim().split('\n').length, 1);
});

test('異常終了したレビューのロックは、次の起動で回収してレビューする', async () => {
  const { dir } = await setup();
  await mkdir(join(prState(dir), '..'), { recursive: true });
  await writeFile(`${prState(dir)}.lock`, String(await deadPid()));
  const { code, argv } = await run([prUrl], undefined, dir);
  assert.equal(code, 0);
  assert.notEqual(argv, null);
});

test('GitHubに問い合わせられなければ、claudeを起動せず、開始も数えずに終了コード2で止まる', async () => {
  const { dir } = await setup();
  await writeFile(join(dir, 'gh-fails'), '');
  const { code, argv, stderr } = await run([prUrl], undefined, dir);
  assert.equal(code, 2);
  assert.equal(argv, null);
  assert.notEqual(stderr, '');
  await assert.rejects(readFile(`${prState(dir)}.reviewed`));
  await assert.rejects(readFile(`${prState(dir)}.lock`));
});

test('最新リリースと版が違えば警告を1行出してからレビューし、同じか確かめられなければ何も出さない', async () => {
  const { dir } = await setup();
  await writeFile(join(dir, 'latest'), 'v99.0.0\n');
  const outdated = await run([prUrl], undefined, dir);
  const current = `v${(await readFile(versionFile, 'utf8')).trim()}`;
  assert.equal(outdated.code, 0);
  assert.notEqual(outdated.argv, null);
  assert.equal(outdated.stderr, `rt: 新しい版 v99.0.0 があります（いまは ${current}）。npx skills update review-team -g（git のチェックアウトなら git pull。--loop は止めてから）で更新してください\n`);
  const upToDate = await run([prUrl]);
  assert.equal(upToDate.code, 0);
  assert.equal(upToDate.stderr, '');
  const { dir: failing } = await setup();
  await writeFile(join(failing, 'latest-fails'), '');
  const unknown = await run([prUrl], undefined, failing);
  assert.equal(unknown.code, 0);
  assert.notEqual(unknown.argv, null);
  assert.equal(unknown.stderr, '');
});

test('相対パスで起動しても動き、claudeにはGitHubの表記のURLを渡す', async () => {
  const ctx = await setup();
  const scripts = join(skillDir, 'scripts');
  const child = spawn('bash', ['rt', 'https://example.test/ACME/widget/pull/7'], { cwd: scripts, env: ctx.env, stdio: 'ignore' });
  assert.equal(await new Promise(done => child.on('exit', done)), 0);
  const argv = (await readFile(join(ctx.dir, 'claude.log'), 'utf8')).trimEnd().split('\n');
  assert.equal(argv.at(-1), prompt([]));
  assert.ok(await readFile(`${prState(ctx.dir)}.lock`, 'utf8'));
});

// The fake node records each scan it is started with, and the fake sleep records its seconds and stops the loop.
async function loop(args) {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-loop-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'node'), `#!/bin/sh\necho "$*" >> "${join(dir, 'node.log')}"\nexit 2\n`);
  await writeFile(join(bin, 'sleep'), `#!/bin/sh\necho "$1" >> "${join(dir, 'sleep.log')}"\nkill $PPID\n`);
  await writeFile(join(bin, 'claude'), `#!/bin/sh\ntouch "${join(dir, 'claude.log')}"\n`);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\necho v0.0.1\n`);
  for (const name of ['node', 'sleep', 'claude', 'gh']) await chmod(join(bin, name), 0o755);
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
  const { code, stderr, scans, sleeps, claude } = await loop(['--loop', '--repo', 'acme/widget',
    '--repo', 'other/gadget.js', '--team', 'opus:xhigh-sol', '--with-consider']);
  assert.equal(code, 'SIGTERM');
  assert.deepEqual(scans, [`${scanner} scan --repo acme/widget --repo other/gadget.js --team opus:xhigh-sol --with-consider`]);
  assert.deepEqual(sleeps, ['600']);
  assert.equal(claude, false);
  assert.match(stderr, /^rt: 新しい版 v0\.0\.1 があります/);
  const plain = await loop(['--loop', '--org', 'acme', '--interval', '30']);
  assert.deepEqual(plain.scans, [`${scanner} scan --org acme`]);
  assert.deepEqual(plain.sleeps, ['1800']);
});

test('--loopの引数の誤りは、scanを起動せずに終了コード1で止まる', async () => {
  for (const args of [
    ['--loop'], ['--loop', '--org', 'acme', prUrl], ['--loop', '--org', 'acme', '--print'],
    ['--loop', '--org', 'acme', '--force'], ['--loop', '--org', 'acme', '--interval', '0'], ['--loop', '--org', 'acme', '--interval', '08'],
    ['--loop', '--org', 'acme', '--interval', '1m'], ['--loop', '--org', 'acme', '--interval'],
    ['--loop', '--org', 'acme', '--team', 'opus-nope'], ['--org', 'acme', prUrl], ['--repo', 'acme/widget', prUrl], ['--interval', '5', prUrl],
    ['--loop', '--org', 'acme', '--repo', 'acme/widget'], ['--loop', '--repo', 'widget'], ['--loop', '--repo', 'a/b/c'],
    ['--loop', '--repo', 'a/'], ['--loop', '--repo', '/b'], ['--loop', '--repo', 'a/-b'], ['--loop', '--repo', 'a b/c'], ['--loop', '--repo', '*/x'],
  ]) {
    const { code, scans, sleeps, claude } = await loop(args);
    assert.equal(code, 1, args.join(' '));
    assert.deepEqual([scans, sleeps, claude], [[], [], false], args.join(' '));
  }
});

// macOS の bash 3.2 は変数名の終わりをバイトごとに isalnum() で判定し、UTF-8 の上位バイトを英字とみなすことがある。
// $current） のように書くと変数名が current\xEF… と読まれ、set -u で unbound variable になる（Linux では再現しない）。
test('rtでは$変数のすぐ後ろに非ASCII文字を書かない（${変数}で囲む）', async () => {
  const lines = (await readFile(wrapper, 'utf8')).split('\n');
  const bad = lines.flatMap((line, i) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
  assert.deepEqual(bad, []);
});
