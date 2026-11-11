#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { acquireLock, escapeXml, gh, locked, prLockPath, readReviewed, readState, releaseLock, scheduleEnv, statePath, stateRoot } from './watch-pr.mjs';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const wrapper = join(dirname(script), 'rt');
const reviewTimeoutMs = () => Number(process.env.REVIEW_TEAM_SCAN_TIMEOUT || 5400) * 1000;
const label = 'io.github.yuki777.review-team.scan';
// A head whose review did not reach its post is tried once more by a later scan, then left until a new push.
const maxAttempts = 2;
const help = `review-team scan: 自分宛てにレビュー依頼が来たPRを探し、review-team でレビューして投稿します。

node scan-prs.mjs scan (--org <組織> | --repo <owner/name>...) [--team <TEAM>] [--with-consider]
    依頼が来ているPRを1件ずつ順に rt --print で動かす
    --org はその組織の全リポジトリ、--repo は owner/name のリポジトリだけを探す（複数回指定できる）。どちらか一方を指定する
node scan-prs.mjs install (--org <組織> | --repo <owner/name>...) [--team <TEAM>] [--with-consider]
    launchd に毎時0分の scan を登録する（macOS）
node scan-prs.mjs uninstall  launchd の登録を外す

対象: user-review-requested:@me の open で draft でないPR（アーカイブ済みのリポジトリと、Renovate（renovate[bot]）が作成したPRを除く）
見送る条件: コンフリクト、または GitHub が mergeable を計算中。CI が失敗、または実行中。--watch でウォッチ中。
同じPRのレビュー（rt か watch の再レビュー）が実行中。head がレビュー済み（投稿まで終えた commit と同じ）。
rt が同じ head のレビューを${maxAttempts}回始めて、どれも投稿まで終わらなかった（新しい push でやり直す）。
同じ scan の中で、その head のレビューをもう始めた（失敗のやり直しは次の scan で）
`;

const scanDir = () => join(stateRoot(), 'scan');

const query = `query($q: String!) { search(type: ISSUE, first: 100, query: $q) { nodes { ... on PullRequest {
  url headRefOid mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

// Several repo: qualifiers are ORed by GitHub search (so are org: and repo:, which is why only one of them is allowed).
const scope = values => values.org ? `org:${values.org}` : values.repo.map(repo => `repo:${repo}`).join(' ');

async function searchPrs(values) {
  const q = `is:pr is:open draft:false archived:false -author:app/renovate user-review-requested:@me ${scope(values)}`;
  const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`]));
  return out.data.search.nodes.map(pr => ({ url: pr.url, head: pr.headRefOid, mergeable: pr.mergeable,
    ci: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null }));
}

// Returns why a PR is left for a later scan, or null to review it now.
async function skipReason(pr, tried) {
  if (pr.mergeable === 'CONFLICTING') return 'conflict';
  if (pr.mergeable !== 'MERGEABLE') return 'mergeable unknown';
  if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') return 'ci failed';
  if (pr.ci === 'PENDING' || pr.ci === 'EXPECTED') return 'ci running';
  const watch = await readState(statePath(pr.url)).catch(() => null);
  if (watch && !watch.stoppedReason) return 'watched';
  if (await locked(prLockPath(pr.url))) return 'running';
  const reviewed = await readReviewed(pr.url);
  if (reviewed.completedHead === pr.head) return 'reviewed';
  if (reviewed.attemptHead === pr.head && reviewed.attempts >= maxAttempts) return 'failed';
  // rt records nothing when it fails before starting claude (gh failing, say), so this keeps one scan from retrying it forever.
  if (tried.has(`${pr.url} ${pr.head}`)) return 'tried';
  return null;
}

const wrapperArgs = values => [...(values.team ? ['--team', values.team] : []),
  ...(values['with-consider'] ? ['--with-consider'] : [])];

// Runs one review in its own process group, so a hung lead is stopped with its reviewers and the next scan can run.
async function review(url, values) {
  const logs = join(scanDir(), 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const log = await open(join(logs, `${new Date().toISOString().replace(/[:.]/g, '-')}-${url.split('/').at(-1)}.log`), 'w', 0o600);
  const args = ['--print', ...wrapperArgs(values), url];
  const code = await new Promise(done => {
    const child = spawn('bash', [wrapper, ...args], { stdio: ['ignore', log.fd, log.fd], detached: true });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    // The review runs in its own process group, so Ctrl-C does not reach it; stop it with the scan.
    const interrupt = signal => { kill('SIGKILL'); process.kill(process.pid, signal); };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.once(signal, interrupt);
    let force;
    let stopping = false;
    const timer = setTimeout(() => { stopping = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 30000); }, reviewTimeoutMs());
    const finish = result => {
      clearTimeout(timer); clearTimeout(force);
      for (const signal of signals) process.off(signal, interrupt);
      done(result);
    };
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

// sv-SE gives local time as YYYY-MM-DD HH:MM:SS, so scan.log shows when each line happened.
const say = message => console.log(`${new Date().toLocaleString('sv-SE')} ${message}`);

async function scan(values) {
  const lock = join(scanDir(), 'scan.lock');
  if (!await acquireLock(lock)) { say('前回の scan が実行中なので終わります。'); return; }
  try {
    const tried = new Set();
    // A review can take an hour or more, so the search is made again before each one and picks one PR that is ready now.
    // Each review is remembered with its head, so the loop ends once every ready PR has been started.
    let reviewed = 0;
    for (;;) {
      let pr;
      let skipped = 0;
      for (const found of await searchPrs(values)) {
        const reason = await skipReason(found, tried);
        if (!reason) { pr = found; break; }
        say(`${found.url} skip (${reason})`);
        if (reason !== 'reviewed' && reason !== 'tried') skipped++;
      }
      if (!pr) {
        say(`scan 終了: レビュー ${reviewed} 件、見送り ${skipped} 件`);
        break;
      }
      tried.add(`${pr.url} ${pr.head}`);
      say(`${pr.url} review ${pr.head.slice(0, 12)}`);
      say(`${pr.url} exit ${await review(pr.url, values)}`);
      reviewed++;
    }
  } finally {
    await releaseLock(lock);
  }
}

const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

function plist(values) {
  const args = [process.execPath, script, 'scan',
    ...(values.org ? ['--org', values.org] : values.repo.flatMap(repo => ['--repo', repo])),
    ...wrapperArgs(values)];
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
    org: { type: 'string' }, repo: { type: 'string', multiple: true }, team: { type: 'string' }, 'with-consider': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (process.env.REVIEW_TEAM_DEPTH) throw new Error('子レビューからの scan は禁止です。');
  if (command === 'scan' || command === 'install') {
    if ((values.org === undefined) === (values.repo === undefined)) throw new Error('--org か --repo のどちらか一方を指定してください。');
    for (const repo of values.repo ?? []) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`--repo は owner/name の形で指定してください: ${repo}`);
    }
  }
  if (command === 'scan') return scan(values);
  if (command === 'install') return install(values);
  if (command === 'uninstall') return uninstall();
  throw new Error(`未対応のコマンドです: ${command}`);
}

// Node resolves symlinks for the entry module, so compare real paths (the skill dir is often a symlink).
if (process.argv[1] && realpathSync(process.argv[1]) === script) {
  await main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
