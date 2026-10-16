#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(import.meta.url);
// A new head is reviewed once a later tick still sees it after this quiet time, so pushes in a row are reviewed once.
const quietMs = () => Number(process.env.REVIEW_TEAM_QUIET ?? 300) * 1000;
const intervalSeconds = 600;
const leadTimeoutMs = () => Number(process.env.REVIEW_TEAM_LEAD_TIMEOUT || 5400) * 1000;
const maxFailures = 2;
const label = 'io.github.yuki777.review-team.watch';
const help = `review-team watch: 投稿したPRに新しいpushがあれば、定期的に再レビューして投稿します。

node watch-pr.mjs record --output <runnerの出力先> [--effort <effort>] [--max-rereviews 3] [--ttl-hours 12]
    投稿に成功したレビューを記録する。未登録のPRなら登録し、tick の定期実行が未登録なら登録する
node watch-pr.mjs tick       ウォッチ中のPRを確かめ、必要なものだけ再レビューを起動する（定期実行の本体）
node watch-pr.mjs list       ウォッチ中・停止済みのPRを表示する
node watch-pr.mjs remove <PR-URL>
                             ウォッチをやめる
node watch-pr.mjs install    launchd に10分ごとの tick を登録する（macOS）。Linux では crontab の行を表示する
node watch-pr.mjs uninstall  launchd の登録を外す

止める条件: PRがマージ・クローズされた、登録から ttl を過ぎた、再レビューが上限に達した、失敗が${maxFailures}回続いた
見送る条件: headがレビュー済み、差分がレビュー済みと同じ、draft、新しいheadを見つけてから次の tick まで（push が続いていないかを見る）、同じPRの再レビューが実行中
`;

function stateRoot() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'review-team');
}

const watchDir = () => join(stateRoot(), 'watch');

function parsePrUrl(url) {
  const [, host, owner, repo, number] = String(url).match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/) ?? [];
  if (!host) throw new Error(`PRのURLを解釈できません: ${url}`);
  return { host, owner, repo, number };
}

function statePath(url) {
  const { host, owner, repo, number } = parsePrUrl(url);
  return join(watchDir(), 'prs', host, owner, repo, `${number}.json`);
}

async function readState(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

// Merges into the state as it is now. A watch removed while tick was asking GitHub stays removed.
async function updateState(file, patch) {
  const current = await readState(file).catch(() => null);
  if (current) await writeState(file, { ...current, ...patch });
}

async function listStateFiles(dir = join(watchDir(), 'prs')) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listStateFiles(path);
    return entry.name.endsWith('.json') ? [path] : [];
  }));
  return files.flat().sort();
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A lock is a file holding the owner's pid. A lock whose owner has exited is taken over.
async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8').catch(() => ''));
      if (pid && alive(pid)) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

async function locked(path) {
  const pid = Number(await readFile(path, 'utf8').catch(() => ''));
  return Boolean(pid) && alive(pid);
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

async function record(values) {
  if (!values.output) throw new Error('--outputが必要です。');
  const output = resolve(values.output);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const url = manifest.repository?.pr?.url;
  if (!url) throw new Error('--prで実行したレビューではありません。');
  const diff = await readFile(join(output, 'reviewed.diff'), 'utf8');
  const file = statePath(url);
  const maxRereviews = Number(values['max-rereviews'] ?? 3);
  const ttlHours = Number(values['ttl-hours'] ?? 12);
  if (!Number.isInteger(maxRereviews) || maxRereviews < 0) throw new Error('--max-rereviewsは0以上の整数にしてください。');
  if (!Number.isFinite(ttlHours) || ttlHours < 0) throw new Error('--ttl-hoursは0以上の数値にしてください。');
  const now = new Date();
  const found = await readState(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  // A stopped watch is registered afresh, so --watch on a PR whose watch expired starts a new one.
  const previous = found?.stoppedReason ? null : found;
  // While a re-review runs, a missing or stopped watch was removed or stopped meanwhile; its post must not bring it back.
  if (!previous && await locked(`${file}.lock`)) {
    console.log(JSON.stringify({ registered: false, state: file, reason: 'ウォッチは再レビュー中に解除または停止されたので、登録し直しません。' }, null, 2));
    return;
  }
  // Re-reviews use the reviewers of the first review, so a reviewer the user left out stays out.
  const reviewers = (manifest.reviewers ?? []).map(r => `${r.cli}:${r.requestedModel}:${r.requestedEffort}`);
  const state = previous ?? {
    pr: url, effort: values.effort ?? 'xhigh', reviewers,
    maxRereviews, registeredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString(),
    rereviews: 0, failures: 0, stoppedReason: null,
  };
  Object.assign(state, { lastReviewedCommit: manifest.repository.commit, lastReviewedDiffSha256: sha256(diff),
    lastPostedAt: now.toISOString(), failures: 0 });
  await writeState(file, state);
  const schedule = await ensureInstalled();
  console.log(JSON.stringify({ registered: !previous, state: file, schedule, ...state }, null, 2));
}

async function gh(args) {
  // A stalled gh would keep tick.lock held and stop every later tick, so each call gets a time limit.
  return (await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 })).stdout;
}

async function fetchPr(url) {
  const query = 'query($url: URI!) { resource(url: $url) { ... on PullRequest { state isDraft headRefOid } } }';
  const out = JSON.parse(await gh(['api', 'graphql', '--hostname', parsePrUrl(url).host, '-f', `query=${query}`, '-f', `url=${url}`]));
  const pr = out.data?.resource;
  if (!pr?.state) throw new Error(`PRを取得できません: ${url}`);
  return { state: pr.state, isDraft: pr.isDraft, head: pr.headRefOid };
}

// Returns what tick should do with one watched PR. Only the gh queries and the state file decide it.
async function decide(state, file, now = Date.now()) {
  if (state.stoppedReason) return { action: 'stopped' };
  if (await locked(`${file}.lock`)) return { action: 'skip', reason: 'running' };
  // Conditions that need only the state come first, so an expired watch stops even while GitHub is unreachable.
  if (now >= Date.parse(state.expiresAt)) return { action: 'stop', reason: 'expired' };
  if (state.failures >= maxFailures) return { action: 'stop', reason: 'failed' };
  const pr = await fetchPr(state.pr);
  if (pr.state !== 'OPEN') return { action: 'stop', reason: pr.state.toLowerCase() };
  if (pr.head === state.lastReviewedCommit) return { action: 'skip', reason: 'reviewed' };
  if (state.rereviews >= state.maxRereviews) return { action: 'stop', reason: 'limit' };
  if (pr.isDraft) return { action: 'skip', reason: 'draft' };
  // Commit dates can be old or skewed after a rebase or cherry-pick, so the quiet time counts from when tick first saw the head.
  if (state.pendingHead !== pr.head) return { action: 'observe', reason: 'settling', head: pr.head };
  if (now - Date.parse(state.pendingSince) < quietMs()) return { action: 'skip', reason: 'settling' };
  if (sha256(await gh(['pr', 'diff', state.pr])) === state.lastReviewedDiffSha256) {
    return { action: 'same-diff', head: pr.head };
  }
  return { action: 'review', head: pr.head };
}

async function tick() {
  const tickLock = join(watchDir(), 'tick.lock');
  if (!await acquireLock(tickLock)) { console.log('前回の tick が実行中なので終わります。'); return; }
  try {
    for (const file of await listStateFiles()) {
      const state = await readState(file).catch(() => null);
      if (!state) continue;
      let decision;
      try {
        decision = await decide(state, file);
      } catch (error) {
        console.error(`${state.pr}: ${error.message}`);
        continue;
      }
      if (decision.action !== 'stopped') console.log(`${state.pr}: ${decision.action}${decision.reason ? ` (${decision.reason})` : ''}`);
      if (decision.action === 'stop') {
        await updateState(file, { stoppedReason: decision.reason, stoppedAt: new Date().toISOString() });
      } else if (decision.action === 'observe') {
        await updateState(file, { pendingHead: decision.head, pendingSince: new Date().toISOString() });
      } else if (decision.action === 'same-diff') {
        await updateState(file, { lastReviewedCommit: decision.head });
      } else if (decision.action === 'review') {
        const child = spawn(process.execPath, [script, 'run', file], { detached: true, stdio: 'ignore' });
        child.unref();
      }
    }
  } finally {
    await rm(tickLock, { force: true });
  }
}

// Runs one re-review for a watched PR. The lead records a successful post with `record`,
// so a run that ends without moving lastPostedAt counts as a failure.
async function run(file) {
  if (!await acquireLock(`${file}.lock`)) return;
  try {
    const state = await readState(file);
    const n = state.rereviews + 1;
    const startedAt = new Date().toISOString();
    await writeState(file, { ...state, rereviews: n, lastAttemptAt: startedAt });
    const logs = join(watchDir(), 'logs');
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const log = await open(join(logs, `${startedAt.replace(/[:.]/g, '-')}-${parsePrUrl(state.pr).number}.log`), 'w', 0o600);
    // Watches registered before reviewers were recorded keep the default of that time, which had no agy.
    const reviewers = state.reviewers ?? ['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high', 'grok:grok-4.7-build-fast:high'];
    const reviewerArgs = reviewers.map(spec => `--reviewer ${spec} `).join('');
    const prompt = `/review-team --comment --rereview ${n}/${state.maxRereviews} ${reviewerArgs}${state.pr}`;
    const lead = process.env.REVIEW_TEAM_LEAD_CLI || 'claude';
    const code = await new Promise(done => {
      // The lead runs in its own process group so a hung run can be stopped with its reviewers,
      // which releases the lock and counts the attempt as a failure.
      const child = spawn(lead, ['-p', '--effort', state.effort, '--permission-mode', 'auto', prompt],
        { cwd: stateRoot(), stdio: ['ignore', log.fd, log.fd], detached: true });
      const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
      let timedOut = false;
      let force;
      const timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        force = setTimeout(() => kill('SIGKILL'), 30000);
      }, leadTimeoutMs());
      child.on('error', () => { clearTimeout(timer); done(-1); });
      child.on('exit', (exitCode, signal) => {
        clearTimeout(timer);
        clearTimeout(force);
        // Reviewers that ignored SIGTERM may outlive the lead; kill the group before the lock is released.
        if (timedOut) kill('SIGKILL');
        done(exitCode ?? signal);
      });
    });
    await log.close();
    // remove may have deleted the watch while the lead ran; leave it deleted.
    const after = await readState(file).catch(() => null);
    if (after) {
      const posted = after.lastPostedAt && after.lastPostedAt >= startedAt;
      await writeState(file, { ...after, lastExitCode: code, failures: posted ? 0 : after.failures + 1 });
    }
  } finally {
    await rm(`${file}.lock`, { force: true });
  }
}

async function list() {
  for (const file of await listStateFiles()) {
    const s = await readState(file).catch(() => null);
    if (!s) continue;
    const status = s.stoppedReason ? `停止(${s.stoppedReason})` : await locked(`${file}.lock`) ? '再レビュー中' : 'ウォッチ中';
    console.log(`${s.pr}\t${status}\t再レビュー ${s.rereviews}/${s.maxRereviews}\t失敗 ${s.failures}\t期限 ${s.expiresAt}\tレビュー済み ${s.lastReviewedCommit?.slice(0, 12)}`);
  }
}

async function remove(url) {
  await rm(statePath(url), { force: true });
  console.log(`ウォッチをやめました: ${url}`);
}

const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// launchd and cron start jobs with a minimal environment, so the current PATH, state directory and CLI overrides are copied in.
const scheduleEnv = () => Object.entries(process.env)
  .filter(([key]) => key === 'PATH' || key === 'XDG_STATE_HOME' || (key.startsWith('REVIEW_TEAM_') && key !== 'REVIEW_TEAM_DEPTH'));

function plist() {
  const env = scheduleEnv();
  const logs = join(watchDir(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(script)}</string><string>tick</string></array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(join(logs, 'tick.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logs, 'tick.log'))}</string>
</dict>
</plist>
`;
}

const shellQuote = text => `'${text.replace(/'/g, `'\\''`)}'`;
const cronLine = () => {
  const env = scheduleEnv().map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  return `*/10 * * * * ${env} ${shellQuote(process.execPath)} ${shellQuote(script)} tick >> ${shellQuote(join(watchDir(), 'logs', 'tick.log'))} 2>&1`;
};

async function install() {
  await mkdir(join(watchDir(), 'logs'), { recursive: true, mode: 0o700 });
  if (process.platform !== 'darwin') return { installed: false, cron: cronLine() };
  const domain = `gui/${process.getuid()}`;
  await mkdir(dirname(plistPath()), { recursive: true });
  await execFileAsync('launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
  await writeFile(plistPath(), plist());
  // ensureInstalled trusts an existing plist, so one that never loaded must not be left behind.
  await execFileAsync('launchctl', ['bootstrap', domain, plistPath()])
    .catch(async error => { await rm(plistPath(), { force: true }); throw error; });
  return { installed: true, plist: plistPath() };
}

// Installs the schedule only when it is missing, so record can call this on every post.
// Linux has no per-user scheduler to write safely, so the crontab line is returned for the lead to report.
async function ensureInstalled() {
  if (process.platform !== 'darwin') return install();
  // A plist written with another PATH or state directory would tick the wrong place, so it is rewritten when it differs.
  if (await readFile(plistPath(), 'utf8').catch(() => null) === plist()) return { installed: false, plist: plistPath() };
  return install();
}

async function uninstall() {
  if (process.platform !== 'darwin') { console.log('crontab -e で tick の行を消してください。'); return; }
  await execFileAsync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]).catch(() => {});
  await rm(plistPath(), { force: true });
  console.log('tick の登録を外しました。');
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    output: { type: 'string' }, effort: { type: 'string' },
    'max-rereviews': { type: 'string' }, 'ttl-hours': { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, arg] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (process.env.REVIEW_TEAM_DEPTH) throw new Error('子レビューからのウォッチ操作は禁止です。');
  if (command === 'record') return record(values);
  if (command === 'tick') return tick();
  if (command === 'run') return run(arg);
  if (command === 'list') return list();
  if (command === 'remove') return remove(arg);
  if (command === 'install') {
    const result = await install();
    console.log(result.installed ? `10分ごとの tick を登録しました: ${result.plist}`
      : `launchd が無いので、crontab -e で次の行を足してください:\n${result.cron}`);
    return;
  }
  if (command === 'uninstall') return uninstall();
  throw new Error(`未対応のコマンドです: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  await main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
