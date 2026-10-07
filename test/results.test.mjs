import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../skills/review-team/scripts/errors.mjs';
import { claude } from '../skills/review-team/scripts/claude.mjs';
import { codex } from '../skills/review-team/scripts/codex.mjs';
import { grok } from '../skills/review-team/scripts/grok.mjs';
import { agy } from '../skills/review-team/scripts/agy.mjs';

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

// Grok runs with the user's normal configuration, so init may list the user's MCP servers and skills.
function grokOutput() {
  return [
    { type: 'system', subtype: 'init', session_id: 'grok-review', model: 'requested-model',
      permissionMode: 'dontAsk', tools: ['read_file', 'bash'], mcp_servers: [{ name: 'github' }], skills: ['code-review'],
      slash_commands: [], cwd: '/private/tmp/review-team', uuid: 'init' },
    { type: 'assistant', message: { id: 'msg_0', type: 'message', role: 'assistant',
      model: 'grok-4.7', content: [{ type: 'text', text: '私は別のモデルです。減算なので不具合です。' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 812, output_tokens: 210 } },
      parent_tool_use_id: null, session_id: 'grok-review', uuid: 'assistant' },
    { type: 'result', subtype: 'success', is_error: false, result: '私は別のモデルです。減算なので不具合です。',
      stop_reason: 'end_turn', duration_ms: 1000, duration_api_ms: 900, num_turns: 1,
      usage: { input_tokens: 812, output_tokens: 210 },
      modelUsage: { 'grok-4.7-build': { inputTokens: 812, outputTokens: 210 } },
      session_id: 'grok-review', uuid: 'result' },
  ].map(event => JSON.stringify(event)).join('\n');
}

test('Grokのinitに利用者のMCPやskillが載っていても、正常完了したレビューを採用し、CLIのモデルメタデータを記録する', () => {
  assert.deepEqual(grok.parse({ stdout: grokOutput(), stderr: '', exitCode: 0 }), {
    text: '私は別のモデルです。減算なので不具合です。',
    actualModels: ['grok-4.7', 'grok-4.7-build'],
    error: null,
  });
});

function agyOutput({ status = 'SUCCESS', response = '減算なので不具合です。\n', error } = {}) {
  return [
    { event: 'init', conversation_id: 'c', init: { model: 'requested-model', cwd: '/tmp/w', tools: ['run_command'], permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: 'c', step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'result', result: { conversation_id: 'c', status, response, ...(error && { error }), num_turns: 1 } },
  ].map(event => JSON.stringify(event)).join('\n');
}

test('agyの完了レビューは本文を採用し、initの要求モデルを実際のモデルとして記録しない', () => {
  assert.deepEqual(agy.parse({ stdout: agyOutput(), stderr: '', exitCode: 0 }),
    { text: '減算なので不具合です。\n', actualModels: [], error: null });
});

test('agyが承認の必要なツールを自動拒否されて本文なしで終わったら、終了コード0でも失敗にしてstderrの理由を残す', () => {
  const stderr = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
  const result = agy.parse({ stdout: agyOutput({ response: '' }), stderr, exitCode: 0 });
  assert.equal(result.error.kind, 'error');
  assert.equal(result.error.message, stderr);
});

test('agyのERROR結果はerror欄から種類を判定する', () => {
  const result = agy.parse({ stdout: agyOutput({ status: 'ERROR', response: '',
    error: 'invalid model selection (--model "x" --effort "high"): model x is not recognized as a known model' }),
  stderr: '', exitCode: 1 });
  assert.equal(result.error.kind, 'model_unavailable');
});

test('agyが機械可読な結果を出さずに終わったらstderrから種類を判定する', () => {
  const result = agy.parse({ stdout: 'Authentication required. Please visit the URL to log in:', stderr: 'error: authentication failed or timed out', exitCode: 1 });
  assert.equal(result.error.kind, 'auth_error');
});
