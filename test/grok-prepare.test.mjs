import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grok } from '../skills/review-team/scripts/grok.mjs';

test('Grokの隔離設定は、隔離したGROK_HOMEに書き出される同梱skillをignoreする', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-"\\\u007f-'));
  const copied = join(dir, 'copied');
  const cli = join(dir, 'fake-grok');
  const report = { grokVersion: '1.0.46 (fake)', hooks: [], mcpServers: [], lspServers: [], projectInstructions: [],
    plugins: [], configSources: { layers: [] } };
  await writeFile(cli, `#!/bin/sh
mkdir -p "$FAKE_GROK_COPY_TO" && cp "$GROK_HOME/config.toml" "$GROK_HOME/requirements.toml" "$FAKE_GROK_COPY_TO/"
echo '${JSON.stringify(report)}'
`);
  await chmod(cli, 0o755);
  await writeFile(join(dir, 'prompt.md'), 'prompt');

  process.env.FAKE_GROK_COPY_TO = copied;
  const { env } = await grok.prepare({ cli, model: 'm', effort: 'high', workDir: dir, promptPath: join(dir, 'prompt.md'),
    grokAllowNoSandbox: true, repo: null });

  const tomlPath = join(env.GROK_HOME, 'bundled', 'skills').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\u007f', '\\u007F');
  const ignored = `[skills]\nignore = ["${tomlPath}"]\n`;
  for (const name of ['config.toml', 'requirements.toml']) {
    assert.ok((await readFile(join(copied, name), 'utf8')).includes(ignored), name);
  }
  await rm(dir, { recursive: true, force: true });
});
