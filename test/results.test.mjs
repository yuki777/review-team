import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agy } from '../skills/review-team/scripts/agy.mjs';
import { classifyError } from '../skills/review-team/scripts/errors.mjs';
import { claude } from '../skills/review-team/scripts/claude.mjs';
import { codex } from '../skills/review-team/scripts/codex.mjs';

for (const [message, expected] of [
  ["The 'gpt-6-astra' model requires a newer version of Codex.", 'model_unavailable'],
  ['model_not_found: model grok-missing does not exist', 'model_unavailable'],
  ['The requested model is not supported with this account', 'model_unavailable'],
  ['401 Unauthorized: Invalid API key', 'auth_error'],
  ['Please run grok login first', 'auth_error'],
  ['error getting token source: You are not logged into Antigravity.', 'auth_error'],
  ['invalid model selection (--model "gemini-9" --effort "high"): model gemini-9 is not recognized as a known model', 'model_unavailable'],
  ['ECONNRESET while connecting to api.example.test', 'network_error'],
  ['503 Service Unavailable', 'network_error'],
  ['Failed to apply sandbox, continuing without sandbox', 'sandbox_error'],
  ['unknown option --tools', 'error'],
]) {
  test(`実行エラーを区別する: ${expected}: ${message}`, () => {
    assert.equal(classifyError(message), expected);
  });
}

test('Claudeの結果本文ではなくCLIのモデルメタデータを記録する', () => {
  assert.deepEqual(claude.parse({
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: '私は別のモデルです。指摘なし。', modelUsage: { 'claude-fable-5-1': {} } }),
    stderr: '', exitCode: 0,
  }), { text: '私は別のモデルです。指摘なし。', actualModels: ['claude-fable-5-1'], error: null });
});

test('Claudeが終了コード0でもAPIエラーを返せば成功にしない', () => {
  const result = claude.parse({ stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution',
    is_error: true, result: 'model_not_found: model unavailable' }), stderr: '', exitCode: 0 });
  assert.equal(result.error.kind, 'model_unavailable');
});

test('Claudeの途中出力を完了レビューとして採用しない', () => {
  assert.equal(claude.parse({ stdout: '{"type":"assistant"}', stderr: '', exitCode: 0 }).error.kind, 'error');
});

const codexHeader = 'OpenAI Codex v0.160.0\n--------\nworkdir: /tmp/w\nmodel: gpt-6-astra\nsandbox: read-only\n--------\n';

test('Codexのメタデータがなければ本文の自己申告を採用せず、sandboxも確認できないので失敗にする', () => {
  const result = codex.parse({ stdout: 'model: gpt-6-astra\n指摘なし。', stderr: '', exitCode: 0 });
  assert.deepEqual(result.actualModels, []);
  assert.equal(result.error.kind, 'sandbox_error');
});

test('Codexがread-only以外のsandboxを報告したら失敗にする', () => {
  const result = codex.parse({ stdout: '指摘なし。', stderr: codexHeader.replace('read-only', 'workspace-write'), exitCode: 0 });
  assert.equal(result.error.kind, 'sandbox_error');
});

test('Codexの通常レビュー本文を認証エラーと取り違えない', () => {
  const result = codex.parse({ stdout: '401 Unauthorizedを握りつぶす不具合があります。', stderr: codexHeader, exitCode: 0 });
  assert.equal(result.error, null);
  assert.deepEqual(result.actualModels, ['gpt-6-astra']);
  assert.equal(result.text, '401 Unauthorizedを握りつぶす不具合があります。');
});


// agy lists every tool in init.tools (run_command included) even when the agent withholds them, so only init.agent tells the agent was applied.
function agyOutput({ status = 'SUCCESS', response = '減算なので不具合です。\n', error, init = { agent: 'review-team-1a2b3c4d' } } = {}) {
  return [
    ...(init ? [{ event: 'init', conversation_id: 'c', init: { model: 'requested-model', cwd: '/tmp/w', ...init, tools: ['run_command'], permission_mode: 'request-review' } }] : []),
    { event: 'step_update', step_update: { conversation_id: 'c', step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'result', result: { conversation_id: 'c', status, response, ...(error && { error }), num_turns: 1 } },
  ].map(event => JSON.stringify(event)).join('\n');
}

test('agyの完了レビューは本文を採用し、initの要求モデルを実際のモデルとして記録しない', () => {
  assert.deepEqual(agy.parse({ stdout: agyOutput(), stderr: '', exitCode: 0 }),
    { text: '減算なので不具合です。\n', actualModels: [], error: null });
});

test('agyが読み取り専用のエージェントで動いたとinitから確認できなければ、本文があっても失敗にする', () => {
  for (const init of [{}, { agent: 'other' }, { agent: 7 }, null]) {
    const result = agy.parse({ stdout: agyOutput({ init }), stderr: '', exitCode: 0 });
    assert.equal(result.error.kind, 'sandbox_error', JSON.stringify(init));
  }
});

test('agyが別のエージェントで動いたとinitが示していれば、レビューが失敗していてもsandbox_errorにする', () => {
  const result = agy.parse({ stdout: agyOutput({ init: { agent: 'other' }, status: 'ERROR', response: '', error: '503 Service Unavailable' }), stderr: '', exitCode: 1 });
  assert.equal(result.error.kind, 'sandbox_error');
});

test('agyが承認の必要なツールを自動拒否されて本文なしで終わったら、終了コード0でも失敗にしてstderrの理由を残す', () => {
  const stderr = 'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.';
  const result = agy.parse({ stdout: agyOutput({ response: '' }), stderr, exitCode: 0 });
  assert.equal(result.error.kind, 'error');
  assert.equal(result.error.message, stderr);
});

test('agyのERROR結果はerror欄から種類を判定する（initが無くてもsandbox_errorにしない）', () => {
  const result = agy.parse({ stdout: agyOutput({ status: 'ERROR', response: '', init: null,
    error: 'invalid model selection (--model "x" --effort "high"): model x is not recognized as a known model' }),
  stderr: '', exitCode: 1 });
  assert.equal(result.error.kind, 'model_unavailable');
});

test('agyが機械可読な結果を出さずに終わったらstderrから種類を判定する', () => {
  const result = agy.parse({ stdout: 'Authentication required. Please visit the URL to log in:', stderr: 'error: authentication failed or timed out', exitCode: 1 });
  assert.equal(result.error.kind, 'auth_error');
});

test('agyには読み取り専用のエージェント定義を作業場所に書いて--agentで指定し、--add-dirはリポジトリがあるときだけ付ける', async () => {
  const names = new Set();
  for (const repo of [undefined, '/tmp/snapshot']) {
    const workDir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
    const { cwd, args, stdin } = await agy.prepare({ model: 'gemini-4-neon', effort: 'xhigh', workDir, prompt: '資料', repo });
    assert.equal(cwd, workDir);
    // The agent name differs on every run, so the reviewed repository cannot ship a definition with the same name.
    const name = args[args.indexOf('--agent') + 1];
    assert.match(name, /^review-team-[0-9a-f]{8}$/);
    names.add(name);
    assert.deepEqual(args, ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', 'gemini-4-neon', '--effort', 'xhigh', '--agent', name, '--disable-slash-commands',
      ...(repo ? ['--add-dir', repo] : [])]);
    assert.deepEqual(JSON.parse(stdin), { event: 'user', message: { content: '資料' } });
    const definition = await readFile(join(workDir, '.agents', 'agents', `${name}.md`), 'utf8');
    assert.match(definition, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(definition, /^excludeDefaultComponents: true$/m);
    assert.doesNotMatch(definition, /run_command|write_|replace_file/);
    await rm(workDir, { recursive: true, force: true });
  }
  assert.equal(names.size, 2);
});
