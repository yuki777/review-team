#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { agy } from './agy.mjs';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { grok } from './grok.mjs';
import { classifyError } from './errors.mjs';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapters = { claude, codex, grok, agy };
const execFileAsync = promisify(execFile);
const help = `review-team: 同一資料を複数のCLI・モデルで独立レビューします。

node run-reviewers.mjs --packet <JSONファイル> --output <新規ディレクトリ>
  --reviewer <cli>:<model>[:<effort>]
                               レビュアーを1人追加する（繰り返し指定可）。指定すると config/reviewers.json の一覧を置き換える
                               cli は claude / codex / grok / agy。effort の既定は high
                               例: --reviewer claude:claude-opus-5-5 --reviewer claude:claude-fable-5-1:max --reviewer codex:gpt-6-astra
  --pr <PR-URL|PR番号>          GitHub の PR を対象にする。リポジトリを状態ディレクトリにキャッシュ用にクローンし、
                               PR の head を読み取り専用で探索させる。資料の diff と intent を省略すると PR から補う
  --repo <パス>                 対象gitリポジトリ。指定コミットのクローンをレビュアーが読み取り専用で探索する
  --ref <コミット>              --repoで読ませるコミット（既定 HEAD）
  --timeout <秒>                各CLIの制限時間（既定 1200、最大3600）
  --help                       説明のみ表示

資料: {"intent":"変更の意図","diff":"差分または変更コード","context":[{"path":"パス","content":"周辺コード"}]}（--pr のときは省略可）
出力: manifest.json、共通prompt.md、各CLIのレビュー本文と実行ログ
終了コード: 0=全員完了、1=不足あり、2=引数または資料の不備
`;

async function loadInput() {
  const { values } = parseArgs({ options: {
    packet: { type: 'string' }, output: { type: 'string' },
    reviewer: { type: 'string', multiple: true },
    timeout: { type: 'string', default: '1200' },
    repo: { type: 'string' }, ref: { type: 'string', default: 'HEAD' }, pr: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return null;
  if (process.env.REVIEW_TEAM_DEPTH) throw new Error('子レビューからのreview-team再起動は禁止です。');
  if (process.platform === 'win32') throw new Error('このランナーはPOSIX環境で実行してください。');
  if (!values.output || !(values.packet || values.pr)) throw new Error('--outputと、--packetまたは--prが必要です。');
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('--timeoutは0より大きく3600以下の秒数にしてください。');
  const reviewers = await loadReviewers(values.reviewer);
  const packet = values.packet ? JSON.parse(await readFile(resolve(values.packet), 'utf8')) : {};
  if (values.pr && (values.repo || values.ref !== 'HEAD')) throw new Error('--prは--repo・--refと同時に指定できません。');
  let repo = null;
  if (values.pr) {
    repo = await resolvePullRequest(values.pr);
    packet.intent ??= [repo.pr.title, repo.pr.body].filter(Boolean).join('\n\n');
    packet.diff ??= repo.pr.diff;
  } else if (values.repo) {
    const path = await realpath(resolve(values.repo)).catch(() => { throw new Error(`--repoが見つかりません: ${values.repo}`); });
    const commit = (await execFileAsync('git', ['-C', path, 'rev-parse', '--verify', '--end-of-options', `${values.ref}^{commit}`])
      .catch(() => { throw new Error(`--repoのgitリポジトリで--ref ${values.ref}を解決できません。`); })).stdout.trim();
    repo = { path, ref: values.ref, commit };
  } else if (values.ref !== 'HEAD') {
    throw new Error('--refは--repoと一緒に指定してください。');
  }
  for (const key of ['intent', 'diff']) {
    if (typeof packet?.[key] !== 'string' || !packet[key].trim()) throw new Error(`資料の${key}は空でない文字列が必要です。`);
  }
  const context = packet.context ?? [];
  if (!Array.isArray(context) || context.some(file => typeof file?.path !== 'string' || !file.path.trim() || typeof file.content !== 'string')) {
    throw new Error('資料のcontextは{path, content}の配列が必要です。');
  }
  const [templateFile, rubric, quality] = await Promise.all(
    ['reviewer-prompt.md', 'rubric.md', 'code-quality-review.md'].map(name => readFile(join(skillDir, 'references', name), 'utf8')),
  );
  // reviewer-prompt.md is the upstream file verbatim: the text after its first "---" line is the template itself.
  const separator = templateFile.indexOf('\n---\n');
  if (separator < 0) throw new Error('reviewer-prompt.mdにテンプレートの区切り（---）がありません。');
  const template = templateFile.slice(separator + '\n---\n'.length).trimStart();
  const buildPrompt = snapshot => {
    const replacements = {
      INTENT: packet.intent,
      DIFF_OR_FILES: JSON.stringify({ diff: packet.diff, context }, null, 2),
      RUBRIC_CONTENTS: rubric,
      CODE_QUALITY_CONTENTS: quality,
    };
    const prompt = template.replace(/\{(INTENT|DIFF_OR_FILES|RUBRIC_CONTENTS|CODE_QUALITY_CONTENTS)\}/g, (_, key) => replacements[key]);
    return snapshot ? `${prompt.trimEnd()}

## Reference Repository

A read-only snapshot of the repository at commit ${repo.commit} is at \`${snapshot}\`. Read whatever you need to verify a finding: callers, types, tests, sibling modules. Read-only commands (\`rg\`, \`grep\`, \`sed -n\`, \`cat\`, \`ls\`, \`git log\`, \`git show\`) and read tools are fine. Uncommitted changes are not in the snapshot, so the diff above is authoritative. Do not read outside this directory.
` : prompt;
  };
  const repository = repo && { path: repo.path, ref: repo.ref, commit: repo.commit,
    ...(repo.pr && { pr: { url: repo.pr.url, number: repo.pr.number, base: repo.pr.base } }) };
  return { reviewers, timeoutMs, buildPrompt, repo, repository, output: resolve(values.output),
    reviewedDiff: repo?.pr ? packet.diff : null };
}

const rootCommit = '6122cb42759dccbb6a17ab020842c79dbc9ca0f9';

async function reviewTeamVersion() {
  const git = (...args) => execFileAsync('git', ['-C', skillDir, ...args]).then(result => result.stdout.trim());
  const top = await git('rev-parse', '--show-toplevel').catch(() => null);
  // Inside another repository (e.g. vendored), git describe would report that repository's version.
  const isOwnCheckout = top && await realpath(join(top, 'skills', 'review-team')).catch(() => null) === await realpath(skillDir)
    && (await git('rev-list', '--max-parents=0', 'HEAD').catch(() => '')).split('\n').includes(rootCommit);
  const described = isOwnCheckout && await git('describe', '--tags', '--always', '--dirty').catch(() => null);
  if (described) return described;
  const file = await readFile(join(skillDir, 'VERSION'), 'utf8').catch(() => null);
  return file ? `v${file.trim()}` : null;
}

function stateRoot() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'review-team');
}

async function resolvePullRequest(spec) {
  const view = await execFileAsync('gh', ['pr', 'view', spec, '--json', 'number,url,title,body,baseRefName'])
    .catch(error => { throw new Error(`PRを取得できません: ${spec}（${error.stderr?.trim() || error.message}）`); });
  const pr = JSON.parse(view.stdout);
  const [, host, owner, name] = pr.url.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+$/) ?? [];
  if (!host) throw new Error(`PRのURLを解釈できません: ${pr.url}`);
  const cache = join(stateRoot(), 'repos', host, owner, name);
  if (!await stat(join(cache, '.git')).catch(() => null)) {
    await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
    await execFileAsync('gh', ['repo', 'clone', `https://${host}/${owner}/${name}`, cache, '--', '--quiet', '--no-checkout'])
      .catch(error => { throw new Error(`リポジトリをクローンできません: ${host}/${owner}/${name}（${error.stderr?.trim() || error.message}）`); });
  }
  const git = (...args) => execFileAsync('git', ['-C', cache, ...args]).then(result => result.stdout.trim());
  const headRef = `refs/review-team/pull/${pr.number}`;
  await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:${headRef}`)
    .catch(error => { throw new Error(`PRのコミットを取得できません（${error.stderr?.trim() || error.message}）`); });
  const commit = await git('rev-parse', '--verify', `${headRef}^{commit}`);
  // gh pr diff compares against the base at PR time, so merged PRs still yield their own changes.
  const diff = (await execFileAsync('gh', ['pr', 'diff', pr.url], { maxBuffer: 64 * 1024 * 1024 })
    .catch(error => { throw new Error(`PRの差分を取得できません（${error.stderr?.trim() || error.message}）`); })).stdout;
  return { path: cache, ref: `pull/${pr.number}/head`, commit,
    pr: { url: pr.url, number: pr.number, title: pr.title, body: pr.body, base: pr.baseRefName, diff } };
}

const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

async function loadReviewers(specs) {
  const entries = specs?.length
    ? specs.map(spec => {
      const [cli, model, effort, ...rest] = spec.split(':');
      if (rest.length) throw new Error(`--reviewerは<cli>:<model>[:<effort>]で指定してください: ${spec}`);
      return { cli, model, effort };
    })
    : JSON.parse(await readFile(join(skillDir, 'config', 'reviewers.json'), 'utf8')).reviewers;
  if (!Array.isArray(entries) || !entries.length) throw new Error('レビュアーを1人以上指定してください。');
  const totals = {};
  for (const { cli } of entries) totals[cli] = (totals[cli] ?? 0) + 1;
  const seen = {};
  return entries.map(({ cli, model, effort = 'high' }) => {
    if (!Object.hasOwn(adapters, cli)) throw new Error(`未対応のCLIです: ${cli}（claude / codex / grok / agy）`);
    if (typeof model !== 'string' || !modelPattern.test(model)) throw new Error(`${cli}のモデルIDが不正です: ${model}`);
    if (typeof effort !== 'string' || !/^[a-z]+$/.test(effort)) throw new Error(`${cli}のreasoning effortが不正です: ${effort}`);
    seen[cli] = (seen[cli] ?? 0) + 1;
    return { id: totals[cli] > 1 ? `${cli}-${seen[cli]}` : cli, cli, model, effort };
  });
}

function execute(invocation, timeoutMs, abortSignal) {
  return new Promise(resolveResult => {
    const env = { ...process.env, REVIEW_TEAM_DEPTH: '1' };
    for (const [key, value] of Object.entries(invocation.env ?? {})) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure = null;
    let killTimer;
    const killGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') failure ??= { kind: 'error', message: error.message };
      }
    };
    const stop = error => {
      if (failure) return;
      failure = error;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
    };
    const onAbort = () => stop({ kind: 'error', message: 'レビューを中断しました。' });
    const timer = setTimeout(() => stop({ kind: 'timeout', message: `${timeoutMs / 1000}秒以内に完了しませんでした。` }), timeoutMs);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= 16 * 1024 * 1024) chunks[stream].push(chunk);
        else stop({ kind: 'error', message: 'CLI出力が16MiBを超えたため中止しました。ログは途中までです。' });
      });
    }
    child.on('error', error => { failure ??= { kind: 'error', message: error.message }; });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stop({ kind: 'error', message: error.message });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      abortSignal.removeEventListener('abort', onAbort);
      killGroup('SIGKILL');
      resolveResult({ stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'), exitCode, signal, failure });
    });
    child.stdin.end(invocation.stdin ?? '');
  });
}

async function review({ id, cli, model, effort }, input, workRoot, abortSignal) {
  const adapter = adapters[cli];
  const started = performance.now();
  const result = { id, cli, requestedModel: model, requestedEffort: effort,
    actualModels: [], modelEvidence: 'unknown', status: 'error',
    cliPath: null, cliVersion: null, exitCode: null, signal: null, durationMs: 0, error: null,
    // Not `${id}.md`: on case-insensitive file systems claude.md would be loaded by Claude Code as CLAUDE.md.
    outputFile: `reviewer-${id}.md`, stdoutFile: `${id}.stdout.log`, stderrFile: `${id}.stderr.log` };
  let stdout = '';
  let stderr = '';
  let text = '';
  try {
    const command = process.env[`REVIEW_TEAM_${cli.toUpperCase()}_CLI`] || adapter.command;
    try {
      result.cliPath = (await execFileAsync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { signal: abortSignal })).stdout.trim();
      result.cliVersion = (await execFileAsync(result.cliPath, ['--version'], { timeout: 10000, signal: abortSignal })).stdout.trim();
    } catch {
      throw new Error(abortSignal.aborted ? 'レビューを中断しました。' : `${command} CLIが見つからないか、バージョンを取得できません。`);
    }
    const workDir = join(workRoot, id);
    await mkdir(workDir, { mode: 0o700 });
    const invocation = await adapter.prepare({ model: result.requestedModel,
      effort: result.requestedEffort, workDir, repo: input.snapshot,
      promptPath: join(input.output, 'prompt.md'), prompt: input.prompt });
    if (abortSignal.aborted) throw new Error('レビューを中断しました。');
    const processResult = await execute({ ...invocation, command: result.cliPath }, input.timeoutMs, abortSignal);
    ({ stdout, stderr } = processResult);
    result.exitCode = processResult.exitCode;
    result.signal = processResult.signal;
    const parsed = adapter.parse(processResult);
    text = parsed.text;
    result.actualModels = parsed.actualModels;
    result.modelEvidence = parsed.actualModels.length ? 'cli_metadata' : 'unknown';
    result.error = processResult.failure ?? parsed.error;
    if (!result.error && (processResult.exitCode !== 0 || !text.trim())) {
      result.error = { kind: 'error', message: 'CLIが正常なレビューを返しませんでした。' };
    }
    result.status = result.error?.kind ?? 'ok';
  } catch (error) {
    result.error = { kind: error.kind ?? classifyError(error.message), message: error.message };
    result.status = result.error.kind;
  }
  result.durationMs = Math.round(performance.now() - started);
  await Promise.all([
    [result.stdoutFile, stdout], [result.stderrFile, stderr], [result.outputFile, text],
  ].map(([name, content]) => writeFile(join(input.output, name), content, { mode: 0o600, flag: 'wx' })));
  return result;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function removeStaleSnapshots(runs) {
  for (const name of await readdir(runs)) {
    const runDir = join(runs, name);
    const pid = Number(await readFile(join(runDir, 'pid'), 'utf8').catch(() => ''));
    const ageMs = Date.now() - (await stat(runDir).catch(() => null))?.mtimeMs;
    if (pid ? !isAlive(pid) : ageMs > 60_000) await removeSnapshot(runDir);
  }
}

async function createSnapshot(repo) {
  const runs = join(stateRoot(), 'runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  await removeStaleSnapshots(runs);
  const runDir = await mkdtemp(join(runs, 'run-'));
  await writeFile(join(runDir, 'pid'), String(process.pid), { mode: 0o600 });
  const src = join(runDir, 'src');
  try {
    // --shared reads the user's objects through alternates instead of hardlinking them,
    // so the chmod below and the cleanup never touch files of the user's repository.
    await execFileAsync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', repo.path, src]);
    await execFileAsync('git', ['-C', src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', repo.commit]);
    await execFileAsync('chmod', ['-R', 'a-w', src]);
  } catch (error) {
    await removeSnapshot(runDir);
    throw new Error(`対象リポジトリのクローンに失敗しました: ${error.message}`);
  }
  return { runDir, src };
}

async function removeSnapshot(runDir) {
  await execFileAsync('chmod', ['-R', 'u+w', runDir]).catch(() => {});
  await rm(runDir, { recursive: true, force: true });
}

async function main() {
  let input;
  let snapshot = null;
  try {
    input = await loadInput();
    if (!input) { console.log(help); return; }
    await mkdir(dirname(input.output), { recursive: true, mode: 0o700 });
    await mkdir(input.output, { mode: 0o700 });
    if (input.repo) snapshot = await createSnapshot(input.repo);
  } catch (error) {
    console.error(error.code === 'EEXIST' ? `出力先が既に存在します: ${input.output}` : error.message);
    process.exitCode = 2;
    return;
  }
  input.snapshot = snapshot?.src ?? null;
  input.prompt = input.buildPrompt(input.snapshot);
  await writeFile(join(input.output, 'prompt.md'), input.prompt, { mode: 0o600, flag: 'wx' });
  if (input.reviewedDiff !== null) await writeFile(join(input.output, 'reviewed.diff'), input.reviewedDiff, { mode: 0o600, flag: 'wx' });
  const workRoot = await mkdtemp(join(tmpdir(), 'review-team-'));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, interrupt);
  const startedAt = new Date().toISOString();
  const version = await reviewTeamVersion();
  try {
    const reviewers = await Promise.all(input.reviewers.map(reviewer =>
      review(reviewer, input, workRoot, controller.signal)));
    const complete = reviewers.every(result => result.status === 'ok');
    const manifest = { schemaVersion: 3, reviewTeamVersion: version, repository: input.repository,
      promptSha256: createHash('sha256').update(input.prompt).digest('hex'),
      startedAt, finishedAt: new Date().toISOString(), complete, reviewers };
    await writeFile(join(input.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ complete, manifest: join(input.output, 'manifest.json'),
      reviewers: reviewers.map(({ id, status, actualModels }) => ({ id, status, actualModels })) }, null, 2));
    process.exitCode = complete ? 0 : 1;
  } finally {
    controller.abort();
    for (const signal of signals) process.removeListener(signal, interrupt);
    await rm(workRoot, { recursive: true, force: true });
    if (snapshot) await removeSnapshot(snapshot.runDir);
  }
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
