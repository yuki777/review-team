import { classifyError } from './errors.mjs';

const disabledFeatures = [
  'shell_tool', 'unified_exec', 'hooks', 'apps', 'plugins', 'multi_agent',
  'multi_agent_v2', 'browser_use', 'computer_use', 'code_mode_host', 'image_generation',
];

export const codex = {
  async prepare({ model, workDir, prompt }) {
    return {
      command: 'codex', cwd: workDir,
      args: ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--ephemeral', '--sandbox', 'read-only', '--model', model, '--color', 'never',
        '-c', 'approval_policy="never"', '-c', 'mcp_servers={}',
        '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
        '-c', 'web_search="disabled"', '-c', 'agents.enabled=false',
        '--enable', 'skip_host_skill_discovery', '--disable', 'skill_search',
        ...disabledFeatures.flatMap(feature => ['--disable', feature]), '-'],
      env: {}, stdin: prompt,
    };
  },
  parse({ stdout, stderr, exitCode }) {
    const header = stderr.match(/^OpenAI Codex v[^\n]+\n--------\n([\s\S]*?)\n--------(?:\n|$)/m)?.[1];
    const model = header?.match(/^model: (\S+)$/m)?.[1];
    const actualModels = model ? [model] : [];
    const text = stdout.trim();
    if (header && !/^sandbox: read-only(?:\s|$)/m.test(header)) {
      return { text, actualModels, error: { kind: 'sandbox_error', message: 'Codexがread-only以外のsandboxを報告しました。' } };
    }
    if (exitCode !== 0 || !text) {
      const messages = [...stderr.matchAll(/^(?:ERROR|Error|error):\s*(.+)$/gm)].map(match => match[1]);
      const message = messages.at(-1) || stderr.trim() || 'Codexのレビューが完了していません。';
      return { text, actualModels, error: { kind: classifyError(message), message } };
    }
    return { text, actualModels, error: null };
  },
};
