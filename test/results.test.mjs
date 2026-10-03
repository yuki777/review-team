import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../skills/review-team/scripts/errors.mjs';
import { claude } from '../skills/review-team/scripts/claude.mjs';
import { codex } from '../skills/review-team/scripts/codex.mjs';
import { grok } from '../skills/review-team/scripts/grok.mjs';

for (const [message, expected] of [
  ["The 'gpt-6-astra' model requires a newer version of Codex.", 'model_unavailable'],
  ['model_not_found: model grok-missing does not exist', 'model_unavailable'],
  ['The requested model is not supported with this account', 'model_unavailable'],
  ['401 Unauthorized: Invalid API key', 'auth_error'],
  ['Please run grok login first', 'auth_error'],
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

test('Codexのメタデータがなければ本文の自己申告を採用しない', () => {
  const result = codex.parse({ stdout: 'model: gpt-6-astra\n指摘なし。', stderr: '', exitCode: 0 });
  assert.deepEqual(result.actualModels, []);
});

test('Codexの通常レビュー本文を認証エラーと取り違えない', () => {
  const result = codex.parse({ stdout: '401 Unauthorizedを握りつぶす不具合があります。', stderr: '', exitCode: 0 });
  assert.equal(result.error, null);
  assert.equal(result.text, '401 Unauthorizedを握りつぶす不具合があります。');
});

function grokOutput({ tools = ['read_file', 'list_dir', 'grep', 'glob'], content, result, toolResults = [] } = {}) {
  return [
    { type: 'system', subtype: 'init', session_id: 'grok-review', model: 'requested-model',
      permissionMode: 'dontAsk', tools, mcp_servers: [], skills: [], slash_commands: [],
      cwd: '/private/tmp/review-team', uuid: 'init' },
    { type: 'assistant', message: { id: 'msg_0', type: 'message', role: 'assistant',
      model: 'grok-4.7', content: content ?? [{ type: 'text', text: '私は別のモデルです。減算なので不具合です。' }],
      stop_reason: content?.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      stop_sequence: null, usage: { input_tokens: 812, output_tokens: 210 } },
      parent_tool_use_id: null, session_id: 'grok-review', uuid: 'assistant' },
    ...(toolResults.length ? [
      { type: 'user', message: { role: 'user', content: toolResults },
        parent_tool_use_id: null, session_id: 'grok-review', uuid: 'tool-results' },
      { type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant',
        model: 'grok-4.7', content: [{ type: 'text', text: result ?? '読み取り完了。' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 812, output_tokens: 210 } },
        parent_tool_use_id: null, session_id: 'grok-review', uuid: 'final-assistant' },
    ] : []),
    { type: 'result', subtype: 'success', is_error: false, result: result ?? '私は別のモデルです。減算なので不具合です。',
      stop_reason: 'end_turn', duration_ms: 1000, duration_api_ms: 900, num_turns: 1,
      usage: { input_tokens: 812, output_tokens: 210 },
      modelUsage: { 'grok-4.7-build': { inputTokens: 812, outputTokens: 210 } },
      session_id: 'grok-review', uuid: 'result' },
  ].map(event => JSON.stringify(event)).join('\n');
}

test('Grokの読み取り専用ツールだけの構成で正常完了したレビューを採用する', () => {
  assert.deepEqual(grok.parse({ stdout: grokOutput(), stderr: '', exitCode: 0 }), {
    text: '私は別のモデルです。減算なので不具合です。',
    actualModels: ['grok-4.7', 'grok-4.7-build'],
    error: null,
  });
});

test('Grokのsandbox適用失敗警告は終了コード0でも拒否する', () => {
  const result = grok.parse({ stdout: grokOutput(),
    stderr: 'Sandbox could not be applied, continuing without sandbox', exitCode: 0 });
  assert.equal(result.error.kind, 'sandbox_error');
  assert.equal(result.text, '');
});

for (const [name, input] of [
  ['read_file', { target_file: '/repo/message.txt' }],
  ['list_dir', { target_directory: '/repo' }],
  ['grep', { pattern: 'PROBE_READ_TOKEN', path: '/repo' }],
  ['glob', { pattern: '**/*.txt', path: '/repo' }],
]) {
  test(`Grokの読み取りツール${name}と対応するtool_resultを許可する`, () => {
    const result = grok.parse({ stdout: grokOutput({
      content: [{ type: 'tool_use', id: 'call_1', name, input }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'PROBE_READ_TOKEN=token', is_error: false }],
      result: 'PROBE_READ_TOKEN=token',
    }), stderr: '', exitCode: 0 });
    assert.equal(result.error, null);
    assert.equal(result.text, 'PROBE_READ_TOKEN=token');
  });
}

for (const name of ['run_terminal_cmd', 'search_replace', 'web_search', 'Task']) {
  test(`Grokの禁止ツール${name}は正常終了でも拒否する`, () => {
    const result = grok.parse({ stdout: grokOutput({
      content: [{ type: 'tool_use', id: 'call_1', name, input: {} }],
    }), stderr: '', exitCode: 0 });
    assert.equal(result.error.kind, 'sandbox_error');
    assert.equal(result.text, '');
  });
}

test('Grokが許可していないツールを広告したら拒否する', () => {
  const result = grok.parse({ stdout: grokOutput({ tools: ['read_file', 'bash'] }),
    stderr: '', exitCode: 0 });
  assert.equal(result.error.kind, 'sandbox_error');
});

test('Grokが対応する読み取り呼び出しのないtool_resultを返したら拒否する', () => {
  const result = grok.parse({ stdout: grokOutput({
    toolResults: [{ type: 'tool_result', tool_use_id: 'unmatched', content: 'unexpected', is_error: false }],
  }), stderr: '', exitCode: 0 });
  assert.equal(result.error.kind, 'sandbox_error');
});
