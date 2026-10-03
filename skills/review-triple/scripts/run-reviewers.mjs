#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  --grok-allow-no-sandbox      Grokをsandboxなしで起動する（sandboxを適用できない環境向け）
  --timeout <秒>                各CLIの制限時間（既定 600、最大3600）
  --help                       説明のみ表示

資料: {"intent":"変更の意図","diff":"差分または変更コード","context":[{"path":"パス","content":"周辺コード"}]}
出力: manifest.json、共通prompt.md、各CLIのレビュー本文と実行ログ
終了コード: 0=3件完了、1=不足あり、2=引数または資料の不備
`;

async function loadInput() {
  const { values } = parseArgs({ options: {
    packet: { type: 'string' }, output: { type: 'string' },
    'claude-model': { type: 'string' }, 'codex-model': { type: 'string' }, 'grok-model': { type: 'string' },
    timeout: { type: 'string', default: '600' }, 'grok-allow-no-sandbox': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  } });
  if (values.help) return null;
  if (process.env.REVIEW_TRIPLE_DEPTH) throw new Error('子レビューからのreview-triple再起動は禁止です。');
  if (process.platform === 'win32') throw new Error('このランナーはPOSIX環境で実行してください。');
  if (!values.packet || !values.output) throw new Error('--packetと--outputが必要です。');
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('--timeoutは0より大きく3600以下の秒数にしてください。');
  const defaults = JSON.parse(await readFile(join(skillDir, 'config', 'models.json'), 'utf8'));
  const models = {};
  for (const provider of Object.keys(adapters)) {
    models[provider] = values[`${provider}-model`] ?? defaults[provider];
    if (typeof models[provider] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(models[provider])) {
      throw new Error(`${provider}のモデルIDが不正です。`);
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
  const [template, rubric, quality] = await Promise.all(
    ['reviewer-prompt.md', 'rubric.md', 'code-quality-review.md'].map(name => readFile(join(skillDir, 'references', name), 'utf8')),
  );
  const replacements = {
    INTENT: packet.intent,
    DIFF_OR_FILES: JSON.stringify({ diff: packet.diff, context }, null, 2),
    RUBRIC_CONTENTS: rubric,
    CODE_QUALITY_CONTENTS: quality,
  };
  const prompt = template.replace(/\{(INTENT|DIFF_OR_FILES|RUBRIC_CONTENTS|CODE_QUALITY_CONTENTS)\}/g, (_, key) => replacements[key]);
  return { models, timeoutMs, prompt, output: resolve(values.output), grokAllowNoSandbox: values['grok-allow-no-sandbox'] };
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
  const result = { provider, requestedModel: input.models[provider], actualModels: [], modelEvidence: 'unknown', status: 'error',
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
    const invocation = await adapter.prepare({ cli: result.cliPath, model: result.requestedModel, workDir,
      grokAllowNoSandbox: input.grokAllowNoSandbox,
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

async function main() {
  let input;
  try {
    input = await loadInput();
    if (input) await mkdir(input.output, { mode: 0o700 });
  } catch (error) {
    console.error(error.code === 'EEXIST' ? `出力先が既に存在します: ${input.output}` : error.message);
    process.exitCode = 2;
    return;
  }
  if (!input) { console.log(help); return; }
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
    const manifest = { schemaVersion: 1, grokSandbox: input.grokAllowNoSandbox ? 'off' : 'required',
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
  }
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
