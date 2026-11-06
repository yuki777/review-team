import test from 'node:test';
import assert from 'node:assert/strict';
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

