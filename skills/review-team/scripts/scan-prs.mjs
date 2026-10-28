#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { acquireLock, escapeXml, gh, readState, scheduleEnv, statePath, stateRoot } from './watch-pr.mjs';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const wrapper = join(dirname(script), 'review-team');
const reviewTimeoutMs = () => Number(process.env.REVIEW_TEAM_SCAN_TIMEOUT || 5400) * 1000;
const label = 'io.github.yuki777.review-team.scan';
const help = `review-team scan: 自分宛てにレビュー依頼が来たPRを探し、review-team でレビューして投稿します。

node scan-prs.mjs scan --org <組織> [--team <TEAM>] [--act-on-only]
    依頼が来ているPRを1件ずつ順に review-team --print で動かす
node scan-prs.mjs install --org <組織> [--team <TEAM>] [--act-on-only]
    launchd に毎時0分の scan を登録する（macOS）
node scan-prs.mjs uninstall  launchd の登録を外す

対象: user-review-requested:@me の open で draft でないPR（アーカイブ済みのリポジトリを除く）
見送る条件: コンフリクト、または GitHub が mergeable を計算中。CI が失敗、または実行中。--watch でウォッチ中。
同じ head でこの scan がレビューを始めたことがある（失敗しても、新しい push まではやり直さない）
`;

const scanDir = () => join(stateRoot(), 'scan');
const startedPath = () => join(scanDir(), 'started.json');

const query = `query($q: String!) { search(type: ISSUE, first: 100, query: $q) { nodes { ... on PullRequest {
  url headRefOid mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

async function searchPrs(org) {
  const q = `is:pr is:open draft:false archived:false user-review-requested:@me org:${org}`;
  const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`]));
  return out.data.search.nodes.map(pr => ({ url: pr.url, head: pr.headRefOid, mergeable: pr.mergeable,
    ci: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null }));
}

// Returns why a PR is left for a later scan, or null to review it now.
async function skipReason(pr, started) {
  if (pr.mergeable === 'CONFLICTING') return 'conflict';
  if (pr.mergeable !== 'MERGEABLE') return 'mergeable unknown';
  if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') return 'ci failed';
  if (pr.ci === 'PENDING' || pr.ci === 'EXPECTED') return 'ci running';
  const watch = await readState(statePath(pr.url)).catch(() => null);
  if (watch && !watch.stoppedReason) return 'watched';
  if (started[pr.url] === pr.head) return 'started';
  return null;
}

// Runs one review in its own process group, so a hung lead is stopped with its reviewers and the next scan can run.
async function review(url, values) {
  const logs = join(scanDir(), 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const log = await open(join(logs, `${new Date().toISOString().replace(/[:.]/g, '-')}-${url.split('/').at(-1)}.log`), 'w', 0o600);
  const args = ['--print', ...(values.team ? ['--team', values.team] : []), ...(values['act-on-only'] ? ['--act-on-only'] : []), url];
  const code = await new Promise(done => {
    const child = spawn('bash', [wrapper, ...args], { stdio: ['ignore', log.fd, log.fd], detached: true });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    let force;
    let stopping = false;
    const timer = setTimeout(() => { stopping = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 30000); }, reviewTimeoutMs());
    const finish = result => { clearTimeout(timer); clearTimeout(force); done(result); };
    child.on('error', () => finish(-1));
    child.on('exit', (exitCode, signal) => {
      // Children that ignored SIGTERM may outlive the lead; kill the group before the next PR starts.
      if (stopping) kill('SIGKILL');
      finish(exitCode ?? signal);
    });
  });
  await log.close();
  return code;
}

async function scan(values) {
  if (!values.org) throw new Error('--orgが必要です。');
  const lock = join(scanDir(), 'scan.lock');
  if (!await acquireLock(lock)) { console.log('前回の scan が実行中なので終わります。'); return; }
  try {
    const started = JSON.parse(await readFile(startedPath(), 'utf8').catch(() => '{}'));
    // A review can take an hour or more, so the search is made again before each one and picks one PR that is ready now.
    // Each review records its head, so the loop ends once every ready PR has been started.
    for (;;) {
      let pr;
      for (const found of await searchPrs(values.org)) {
        const reason = await skipReason(found, started);
        if (!reason) { pr = found; break; }
        console.log(`${found.url}: skip (${reason})`);
      }
      if (!pr) break;
      // Recorded before the review, so a review that fails is not retried every hour on the same head.
      started[pr.url] = pr.head;
      await writeFile(startedPath(), JSON.stringify(started, null, 2) + '\n', { mode: 0o600 });
      console.log(`${pr.url}: review ${pr.head.slice(0, 12)}`);
      console.log(`${pr.url}: exit ${await review(pr.url, values)}`);
    }
  } finally {
    await rm(lock, { force: true });
  }
}

const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

function plist(values) {
  const args = [process.execPath, script, 'scan', '--org', values.org,
    ...(values.team ? ['--team', values.team] : []), ...(values['act-on-only'] ? ['--act-on-only'] : [])];
  const log = escapeXml(join(scanDir(), 'logs', 'scan.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map(arg => `<string>${escapeXml(arg)}</string>`).join('')}</array>
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>0</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
${scheduleEnv().map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

async function install(values) {
  if (!values.org) throw new Error('--orgが必要です。');
  if (process.platform !== 'darwin') throw new Error('install は macOS（launchd）だけです。ほかでは scan を定期実行してください。');
  const domain = `gui/${process.getuid()}`;
  await mkdir(join(scanDir(), 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(plistPath()), { recursive: true });
  await execFileAsync('launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
  await writeFile(plistPath(), plist(values));
  await execFileAsync('launchctl', ['bootstrap', domain, plistPath()])
    .catch(async error => { await rm(plistPath(), { force: true }); throw error; });
  console.log(`毎時0分の scan を登録しました: ${plistPath()}`);
}

async function uninstall() {
  await execFileAsync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]).catch(() => {});
  await rm(plistPath(), { force: true });
  console.log('scan の登録を外しました。');
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    org: { type: 'string' }, team: { type: 'string' }, 'act-on-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (process.env.REVIEW_TEAM_DEPTH) throw new Error('子レビューからの scan は禁止です。');
  if (command === 'scan') return scan(values);
  if (command === 'install') return install(values);
  if (command === 'uninstall') return uninstall();
  throw new Error(`未対応のコマンドです: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  await main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
