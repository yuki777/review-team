import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { classifyError } from './errors.mjs';

const execFileAsync = promisify(execFile);
const supportedVersion = /^1\.0\.46(?:\s|$)/;
const sandboxFailure = /continuing without (?:a )?sandbox|sandbox[^\n]*(?:could not|cannot|failed|not supported|unavailable|disabled|not applied)|(?:could not|cannot|failed|unable) to (?:apply|initialize|start|enable)[^\n]*sandbox|protections missing|refusing to start with[^\n]*sandbox/i;

function sandboxError(message) {
  return Object.assign(new Error(message), { kind: 'sandbox_error' });
}

const settings = `[agent]
name = "review-triple"
[cli]
auto_update = false
use_leader = false
[features]
managed_config = false
campaigns = false
backend_tools = false
write_file = false
lsp_tools = false
codebase_indexing = false
[managed_mcps]
enabled = false
gateway_tools_enabled = false
[subagents]
enabled = false
[memory]
enabled = false
[memory_v2]
enabled = false
[workflows]
enabled = false
[session]
load_envrc = false
[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
[compat.codex]
skills = false
hooks = false
`;

// Grok rejects an empty curated toolset. Register only a read-only tool, while
// deny-all prevents even that tool from executing during bounded packet review.
const profile = `---
name: review-triple
description: Bounded packet reviewer
permissionMode: dontAsk
toolConfig:
  tools:
    - id: GrokBuild:read_file
      kind: read
injectDefaultTools: false
discoverSkills: false
inheritSkills: false
agentsMd: false
mcpServers: []
mcpInheritance: none
---
渡されたレビューpacketだけを評価する。ツールの利用、コードの変更・実行、他agentへの委譲はしない。
`;

function isolatedEnvironment(home, grokHome, authPath) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GROK_') || key.startsWith('__GROK_')) env[key] = null;
  }
  // Keep an existing native inline login or API key; never read/copy its bytes.
  if (process.env.GROK_AUTH) env.GROK_AUTH = process.env.GROK_AUTH;
  return Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GROK_HOME: grokHome,
    GROK_AUTH_PATH: authPath,
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_MEMORY: '0',
    GROK_SUBAGENTS: '0',
    GROK_WORKFLOWS: '0',
    GROK_BACKEND_SEARCH: '0',
    GROK_WRITE_FILE: '0',
    GROK_WEB_FETCH: '0',
    GROK_LSP_TOOLS: '0',
    GROK_MANAGED_MCPS_ENABLED: '0',
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0',
    GROK_CAMPAIGNS: '0',
    RUST_LOG: 'warn',
    NO_COLOR: '1',
  });
}

async function inspectIsolation(cwd, overrides) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  let report;
  try {
    const { stdout, stderr } = await execFileAsync('grok', ['inspect', '--json'], {
      cwd, env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (sandboxFailure.test(stderr)) throw sandboxError('Grokの隔離設定を適用できません。');
    report = JSON.parse(stdout);
  } catch {
    // Inspection can include configured endpoints: do not echo it into errors.
    throw sandboxError('Grokの隔離設定を検査できません。Grok Build 1.0.46が必要です。');
  }
  if (!supportedVersion.test(report.grokVersion ?? '')) {
    throw sandboxError('このadapterはGrok Build 1.0.46の隔離仕様に限定されています。');
  }
  for (const field of ['hooks', 'mcpServers', 'lspServers', 'projectInstructions']) {
    if (!Array.isArray(report[field]) || report[field].some(entry => !entry.disabled)) {
      throw sandboxError(`Grokの隔離環境に${field}が読み込まれています。`);
    }
  }
  if (!Array.isArray(report.plugins) || report.plugins.some(entry => entry.enabled)) {
    throw sandboxError('Grokの隔離環境にpluginが読み込まれています。');
  }
  const layers = report.configSources?.layers;
  if (!Array.isArray(layers) || layers.some(layer => {
    if (layer.note === 'empty') return false;
    return layer.note || !['user', 'requirements'].includes(layer.role)
      || ![join(overrides.GROK_HOME, 'config.toml'), join(overrides.GROK_HOME, 'requirements.toml')].includes(layer.path);
  })) {
    throw sandboxError('Grokに外部の管理設定が適用されているため、隔離を保証できません。');
  }
}

export const grok = {
  async prepare({ model, workDir, promptPath }) {
    const cwd = await realpath(workDir);
    const home = join(cwd, 'home');
    const grokHome = join(home, '.grok');
    const nativeHome = resolve(process.env.GROK_HOME || join(homedir(), '.grok'));
    const authPath = resolve(process.env.GROK_AUTH_PATH || join(nativeHome, 'auth.json'));
    await mkdir(home, { mode: 0o700 });
    await mkdir(grokHome, { mode: 0o700 });
    await writeFile(join(grokHome, 'config.toml'), settings, { mode: 0o600, flag: 'wx' });
    await writeFile(join(grokHome, 'requirements.toml'), settings, { mode: 0o600, flag: 'wx' });
    const profilePath = join(cwd, 'reviewer.profile');
    await writeFile(profilePath, profile, { mode: 0o600, flag: 'wx' });
    // Native OAuth refresh uses an atomic sibling-file rename and auth.json.lock.
    // Grant only that native auth directory, without importing its config/hooks.
    await writeFile(join(grokHome, 'sandbox.toml'),
      `[profiles.review-triple]\nextends = "read-only"\nrestrict_network = true\nread_write = [${JSON.stringify(dirname(authPath))}]\n`,
      { mode: 0o600, flag: 'wx' });
    const env = isolatedEnvironment(home, grokHome, authPath);
    await inspectIsolation(cwd, env);
    return {
      command: 'grok',
      args: [
        '--prompt-file', promptPath, '--verbatim', '--model', model,
        '--agent', profilePath, '--permission-mode', 'dontAsk', '--deny', '*',
        '--sandbox', 'review-triple', '--no-plan', '--no-subagents',
        '--disable-web-search', '--output-format', 'streaming-messages-json',
      ],
      cwd,
      env,
    };
  },

  parse({ stdout, stderr, exitCode }) {
    const actualModels = [];
    const fail = (kind, message) => ({ text: '', actualModels, error: { kind, message } });
    if (sandboxFailure.test(stderr)) {
      return fail('sandbox_error', 'Grokのsandbox適用失敗を検出しました。終了コードにかかわらずレビューを無効にします。');
    }
    let events;
    try {
      events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      if (events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) throw new Error();
    } catch {
      const kind = exitCode === 0 ? 'error' : classifyError(stderr);
      return fail(kind, 'Grokから有効な機械可読レビュー結果を取得できませんでした。');
    }
    for (const event of events) {
      // These are CLI execution metadata, not server attestation. Grok may fill
      // missing response IDs from the selected model; never use init.model.
      const usage = event.modelUsage;
      const models = event.type === 'assistant' ? [event.message?.model]
        : event.type === 'result' && usage && typeof usage === 'object' && !Array.isArray(usage)
          ? Object.keys(usage) : [];
      for (const model of models) {
        if (typeof model === 'string' && model.trim() && model !== 'unknown' && !actualModels.includes(model)) actualModels.push(model);
      }
    }
    const result = events.findLast(event => event.type === 'result');
    const reportedErrors = Array.isArray(result?.errors)
      ? result.errors.filter(message => typeof message === 'string') : [];
    if (exitCode !== 0 || result?.is_error
      || typeof result?.subtype === 'string' && result.subtype.startsWith('error_')) {
      const kind = classifyError([...reportedErrors, stderr].join('\n'));
      return fail(kind, 'Grokのレビュー実行が失敗しました。');
    }
    const init = events.find(event => event.type === 'system' && event.subtype === 'init');
    if (!init || init.permissionMode !== 'dontAsk'
      || !Array.isArray(init.tools) || init.tools.some(tool => tool !== 'read_file')
      || ['mcp_servers', 'skills'].some(field => !Array.isArray(init[field]) || init[field].length)) {
      return fail('sandbox_error', 'Grokの許可ツール制限・MCP・skill無効化を実行結果から確認できません。');
    }
    if (events.some(event => event.type === 'user' || event.type === 'assistant'
      && Array.isArray(event.message?.content)
      && event.message.content.some(block => ['tool_use', 'server_tool_use', 'web_search_tool_result'].includes(block?.type)))) {
      return fail('sandbox_error', 'Grokが禁止されたツールの呼び出しを要求しました。');
    }
    if (!result || result !== events.at(-1) || result.subtype !== 'success'
      || result.is_error !== false || result.stop_reason !== 'end_turn'
      || typeof result.result !== 'string' || !result.result.trim()) {
      return fail('error', 'Grokのレビューが正常完了していないか、本文が空です。');
    }
    return { text: result.result, actualModels, error: null };
  },
};
