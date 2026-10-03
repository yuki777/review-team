#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { grok } from './grok.mjs';
import { classifyError } from './errors.mjs';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapters = { claude, codex, grok };
const execFileAsync = promisify(execFile);
const help = `review-triple: 同一資料を3つのCLIで独立レビューします。

node run-reviewers.mjs --packet <JSONファイル> --output <新規ディレクトリ>
  --claude-model <ID>          Claudeのモデル（既定は config/models.json）
  --codex-model <ID>           Codexのモデル（同上）
  --grok-model <ID>            Grokのモデル（同上）
  --claude-effort <値>         Claudeのreasoning effort（既定は config/models.json）
  --codex-effort <値>          Codexのreasoning effort（同上）
  --grok-effort <値>           Grokのreasoning effort（同上）
  --repo <パス>                 対象gitリポジトリ。指定コミットのクローンをレビュアーが読み取り専用で探索する
  --ref <コミット>              --repoで読ませるコミット（既定 HEAD）
  --grok-allow-no-sandbox      Grokをsandboxなしで起動する（sandboxを適用できない環境向け）
  --timeout <秒>                各CLIの制限時間（既定 1200、最大3600）
  --help                       説明のみ表示

資料: {"intent":"変更の意図","diff":"差分または変更コード","context":[{"path":"パス","content":"周辺コード"}]}
出力: manifest.json、共通prompt.md、各CLIのレビュー本文と実行ログ
終了コード: 0=3件完了、1=不足あり、2=引数または資料の不備
`;

async function loadInput() {
  const { values } = parseArgs({ options: {
    packet: { type: 'string' }, output: { type: 'string' },
    'claude-model': { type: 'string' }, 'codex-model': { type: 'string' }, 'grok-model': { type: 'string' },
    'claude-effort': { type: 'string' }, 'codex-effort': { type: 'string' }, 'grok-effort': { type: 'string' },
    timeout: { type: 'string', default: '1200' }, 'grok-allow-no-sandbox': { type: 'boolean', default: false },
    repo: { type: 'string' }, ref: { type: 'string', default: 'HEAD' },
  } });
  if (values.help) return null;
  if (process.env.REVIEW_TRIPLE_DEPTH) throw new Error('子レビューからのreview-triple再起動は禁止です。');
  if (process.platform === 'win32') throw new Error('このランナーはPOSIX環境で実行してください。');
  if (!values.packet || !values.output) throw new Error('--packetと--outputが必要です。');
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('--timeoutは0より大きく3600以下の秒数にしてください。');
  const defaults = JSON.parse(await readFile(join(skillDir, 'config', 'models.json'), 'utf8'));
  const models = {};
  const efforts = {};
  for (const provider of Object.keys(adapters)) {
    models[provider] = values[`${provider}-model`] ?? defaults[provider]?.model;
    efforts[provider] = values[`${provider}-effort`] ?? defaults[provider]?.effort;
    if (typeof models[provider] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(models[provider])) {
      throw new Error(`${provider}のモデルIDが不正です。`);
    }
    if (typeof efforts[provider] !== 'string' || !/^[a-z]+$/.test(efforts[provider])) {
      throw new Error(`${provider}のreasoning effortが不正です。`);
    }
  }
  const packet = JSON.parse(await readFile(resolve(values.packet), 'utf8'));
  for (const key of ['intent', 'diff']) {
    if (typeof packet?.[key] !== 'string' || !packet[key].trim()) throw new Error(`資料の${key}は空でない文字列が必要です。`);
  }
  const context = packet.context ?? [];
  if (!Array.isArray(context) || context.some(file => typeof file?.path !== 'string' || !file.path.trim() || typeof file.content !== 'string')) {
    throw new Error('資料のcontextは{path, content}の配列が必要です。');
  }
  let repo = null;
  if (values.repo) {
    const path = await realpath(resolve(values.repo)).catch(() => { throw new Error(`--repoが見つかりません: ${values.repo}`); });
    const commit = (await execFileAsync('git', ['-C', path, 'rev-parse', '--verify', '--end-of-options', `${values.ref}^{commit}`])
      .catch(() => { throw new Error(`--repoのgitリポジトリで--ref ${values.ref}を解決できません。`); })).stdout.trim();
    repo = { path, ref: values.ref, commit };
  } else if (values.ref !== 'HEAD') {
    throw new Error('--refは--repoと一緒に指定してください。');
  }
  const [template, rubric, quality] = await Promise.all(
    ['reviewer-prompt.md', 'rubric.md', 'code-quality-review.md'].map(name => readFile(join(skillDir, 'references', name), 'utf8')),
  );
  const buildPrompt = snapshot => {
    const replacements = {
      INTENT: packet.intent,
      DIFF_OR_FILES: JSON.stringify({ diff: packet.diff, context }, null, 2),
      RUBRIC_CONTENTS: rubric,
      CODE_QUALITY_CONTENTS: quality,
      REPOSITORY_SCOPE: snapshot
        ? `対象リポジトリのスナップショット（コミット ${repo.commit}）を \`${snapshot}\` に読み取り専用で置いています。呼び出し元・型・テスト・隣接モジュールなど、判断に必要なファイルは自由に読んで裏付けを取ってください。ファイルを読むだけのコマンド（\`rg\`、\`grep\`、\`sed -n\`、\`cat\`、\`ls\`、\`git log\` / \`git show\` など）や読み取り用ツールは使ってかまいません。未コミットの変更はスナップショットに含まれないため、上の差分を正とします。このディレクトリの外は読みません。`
        : '判断材料はこの入力だけです。ファイルパスは出典ラベルであり、読み取り権限ではありません。対象リポジトリは提供されていないので探索しません。',
    };
    return template.replace(/\{(INTENT|DIFF_OR_FILES|RUBRIC_CONTENTS|CODE_QUALITY_CONTENTS|REPOSITORY_SCOPE)\}/g, (_, key) => replacements[key]);
  };
  return { models, efforts, timeoutMs, buildPrompt, repo, output: resolve(values.output), grokAllowNoSandbox: values['grok-allow-no-sandbox'] };
}

function execute(invocation, timeoutMs, abortSignal) {
  return new Promise(resolveResult => {
    const env = { ...process.env, REVIEW_TRIPLE_DEPTH: '1' };
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

async function review(provider, adapter, input, workRoot, abortSignal) {
  const started = performance.now();
  const result = { provider, requestedModel: input.models[provider], requestedEffort: input.efforts[provider],
    actualModels: [], modelEvidence: 'unknown', status: 'error',
    cliPath: null, cliVersion: null, exitCode: null, signal: null, durationMs: 0, error: null,
    outputFile: `${provider}.md`, stdoutFile: `${provider}.stdout.log`, stderrFile: `${provider}.stderr.log` };
  let stdout = '';
  let stderr = '';
  let text = '';
  try {
    const command = process.env[`REVIEW_TRIPLE_${provider.toUpperCase()}_CLI`] || adapter.command;
    try {
      result.cliPath = (await execFileAsync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { signal: abortSignal })).stdout.trim();
      result.cliVersion = (await execFileAsync(result.cliPath, ['--version'], { timeout: 10000, signal: abortSignal })).stdout.trim();
    } catch {
      throw new Error(abortSignal.aborted ? 'レビューを中断しました。' : `${command} CLIが見つからないか、バージョンを取得できません。`);
    }
    const workDir = join(workRoot, provider);
    await mkdir(workDir, { mode: 0o700 });
    const invocation = await adapter.prepare({ cli: result.cliPath, model: result.requestedModel,
      effort: result.requestedEffort, workDir,
      grokAllowNoSandbox: input.grokAllowNoSandbox, repo: input.snapshot,
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
  const runs = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'review-triple', 'runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  await removeStaleSnapshots(runs);
  const runDir = await mkdtemp(join(runs, 'run-'));
  await writeFile(join(runDir, 'pid'), String(process.pid), { mode: 0o600 });
  const src = join(runDir, 'src');
  try {
    await execFileAsync('git', ['clone', '--quiet', '--local', '--no-checkout', '--', repo.path, src]);
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
  const workRoot = await mkdtemp(join(tmpdir(), 'review-triple-'));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, interrupt);
  const startedAt = new Date().toISOString();
  try {
    const reviewers = await Promise.all(Object.entries(adapters).map(([provider, adapter]) =>
      review(provider, adapter, input, workRoot, controller.signal)));
    const complete = reviewers.every(result => result.status === 'ok');
    const manifest = { schemaVersion: 1, grokSandbox: input.grokAllowNoSandbox ? 'off' : 'required', repository: input.repo,
      promptSha256: createHash('sha256').update(input.prompt).digest('hex'),
      startedAt, finishedAt: new Date().toISOString(), complete, reviewers };
    await writeFile(join(input.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ complete, manifest: join(input.output, 'manifest.json'),
      reviewers: reviewers.map(({ provider, status, actualModels }) => ({ provider, status, actualModels })) }, null, 2));
    process.exitCode = complete ? 0 : 1;
  } finally {
    controller.abort();
    for (const signal of signals) process.removeListener(signal, interrupt);
    await rm(workRoot, { recursive: true, force: true });
    if (snapshot) await removeSnapshot(snapshot.runDir);
  }
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
