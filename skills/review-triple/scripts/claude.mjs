import { classifyError } from './errors.mjs';

export const claude = {
  command: 'claude',
  async prepare({ model, workDir, prompt }) {
    return {
      cwd: workDir,
      args: ['--print', '--model', model, '--output-format', 'json',
        '--safe-mode', '--restricted', '--setting-sources', '',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--tools', '', '--permission-mode', 'dontAsk',
        '--permission-prompts', 'none', '--no-session-persistence'],
      env: { CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null }, stdin: prompt,
    };
  },
  parse({ stdout, stderr, exitCode }) {
    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      const message = stderr.trim() || 'Claude CLIが完了JSONを返しませんでした。';
      return { text: '', actualModels: [], error: { kind: classifyError(message), message } };
    }
    const actualModels = Object.keys(result.modelUsage ?? {});
    const text = typeof result.result === 'string' ? result.result : '';
    if (exitCode !== 0 || result.type !== 'result' || result.subtype !== 'success' || result.is_error || !text.trim()) {
      const message = result.errors?.join('\n') || text || stderr.trim() || 'Claudeのレビューが完了していません。';
      return { text, actualModels, error: { kind: classifyError(message), message } };
    }
    return { text, actualModels, error: null };
  },
};
