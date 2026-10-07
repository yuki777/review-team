import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyError } from './errors.mjs';

const agentName = 'review-team';

// agy discovers workspace agents in <cwd>/.agents/agents/. The runner writes this file into the
// reviewer's own work directory on every run, so nothing has to be installed in ~/.gemini.
// A missing or unknown --agent is ignored by agy (it falls back to the default agent), so this file
// only narrows the toolset; it is not a precondition for running.
const agentDefinition = `---
name: ${agentName}
description: Read-only reviewer
tools:
excludeDefaultComponents: true
  - view_file
  - grep_search
  - list_dir
  - find_by_name
mainAgent: true
subagent: false
---
渡されたレビューpacketを読み取り専用で評価する。参照用repositoryが渡された場合だけ、読み取り系ツールで探索する。
コードの変更・実行、shell・web・MCPの利用、他agentへの委譲、review-teamの再帰呼出しは禁止する。
`;

export const agy = {
  command: 'agy',
  async prepare({ model, effort, workDir, prompt, repo }) {
    const agentsDir = join(workDir, '.agents', 'agents');
    await mkdir(agentsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(agentsDir, `${agentName}.md`), agentDefinition, { mode: 0o600, flag: 'wx' });
    return {
      cwd: workDir,
      // The prompt can be larger than the argv limit, so it is sent as one stream-json turn on stdin.
      args: ['--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', model, '--effort', effort, '--agent', agentName, '--disable-slash-commands',
        ...(repo ? ['--add-dir', repo] : [])],
      env: {},
      stdin: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
    };
  },
  parse({ stdout, stderr, exitCode }) {
    // agy reports only the requested model (init.model), not the model that answered.
    const actualModels = [];
    let result;
    try {
      const events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      result = events.findLast(event => event?.event === 'result')?.result;
    } catch {
      result = undefined;
    }
    const text = typeof result?.response === 'string' ? result.response : '';
    if (exitCode !== 0 || result?.status !== 'SUCCESS' || !text.trim()) {
      // A tool that needs approval is auto-denied in headless mode; agy then ends with an empty
      // response and explains it only on stderr.
      const message = (typeof result?.error === 'string' && result.error) || stderr.trim()
        || 'Antigravity CLIのレビューが完了していません。';
      return { text, actualModels, error: { kind: classifyError(message), message } };
    }
    return { text, actualModels, error: null };
  },
};
