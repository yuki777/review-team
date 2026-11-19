import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyError } from './errors.mjs';

const agentPrefix = 'review-team-';

// agy has no sandbox: without a custom agent, headless mode writes files and runs commands unprompted.
// With this one (agy 1.5.12) the model can only read single files; the list and search tools are not offered.
// agy discovers workspace agents in <cwd>/.agents/agents/, so the runner writes the file into the
// reviewer's own work directory on every run and nothing has to be installed in ~/.gemini.
const agentDefinition = name => `---
name: ${name}
description: Read-only reviewer
excludeDefaultComponents: true
tools:
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

const unconfined = { kind: 'sandbox_error', message: 'agyが読み取り専用のエージェントで動いたことを出力から確認できません。' };

export const agy = {
  command: 'agy',
  async prepare({ model, effort, workDir, prompt, repo }) {
    // agy also searches --add-dir directories for agents. The name is random, so a definition
    // shipped in the reviewed repository can never be the one that --agent selects.
    const agentName = `${agentPrefix}${randomUUID().slice(0, 8)}`;
    const agentsDir = join(workDir, '.agents', 'agents');
    await mkdir(agentsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(agentsDir, `${agentName}.md`), agentDefinition(agentName), { mode: 0o600, flag: 'wx' });
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
    let events = [];
    try {
      events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    } catch {
      // Not stream-json: handled below as a run without a result.
    }
    const result = events.findLast(event => event?.event === 'result')?.result;
    const text = typeof result?.response === 'string' ? result.response : '';
    // init.agent is the agent that agy applied; it is absent when agy fell back to its default agent.
    const inits = events.filter(event => event?.event === 'init');
    if (inits.some(event => !event.init?.agent?.startsWith?.(agentPrefix))) return { text, actualModels, error: unconfined };
    if (exitCode !== 0 || result?.status !== 'SUCCESS' || !text.trim()) {
      // A tool that needs approval is auto-denied in headless mode; agy then ends with an empty
      // response and explains it only on stderr.
      const message = (typeof result?.error === 'string' && result.error) || stderr.trim()
        || 'Antigravity CLIのレビューが完了していません。';
      return { text, actualModels, error: { kind: classifyError(message), message } };
    }
    if (!inits.length) return { text, actualModels, error: unconfined };
    return { text, actualModels, error: null };
  },
};
