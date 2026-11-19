#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const help = `review-team config: 利用者の設定ファイル（\${XDG_CONFIG_HOME:-~/.config}/review-team/rt.json）を読みます。

node config.mjs loop    設定ファイルを確かめ、loop の値を「org <組織>」「repo <owner/name>」「interval <分>」の行で出す（rt --loop 用）

設定ファイルが無ければ何も出さずに終わる。書けるキーは reviewers と loop（org か repos、interval）だけ。
JSON として読めない、知らないキーがある、値の形が違うときは、終了コード 2 で終わる。
`;

export function configPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'review-team', 'rt.json');
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// rt expands these into a command line unquoted, so they must not hold spaces, glob characters or a leading "-".
const orgPattern = /^[A-Za-z0-9][\w.-]*$/;
const repoPattern = /^[A-Za-z0-9._][\w.-]*\/[A-Za-z0-9._][\w.-]*$/;

function check(config) {
  if (!isObject(config)) throw new Error('全体を JSON のオブジェクトにしてください');
  // An unknown key is an error, so a misspelt one (say "reviewer") does not silently run the defaults.
  const known = (object, keys, where) => {
    for (const key of Object.keys(object)) {
      if (!keys.includes(key)) throw new Error(`知らないキーです: ${where}${key}（書けるのは ${keys.join('・')}）`);
    }
  };
  known(config, ['reviewers', 'loop'], '');
  const { reviewers, loop = {} } = config;
  if (reviewers !== undefined && !(Array.isArray(reviewers) && reviewers.length && reviewers.every(isObject))) {
    throw new Error('reviewers は {cli, model, effort} を1人以上並べた配列にしてください');
  }
  // The values of each reviewer are checked by run-reviewers.mjs, which knows the CLIs.
  for (const reviewer of reviewers ?? []) known(reviewer, ['cli', 'model', 'effort'], 'reviewers[].');
  if (!isObject(loop)) throw new Error('loop はオブジェクトにしてください');
  known(loop, ['org', 'repos', 'interval'], 'loop.');
  const { org, repos, interval } = loop;
  if (org !== undefined && repos !== undefined) throw new Error('loop.org と loop.repos はどちらか一方だけにしてください');
  if (org !== undefined && !(typeof org === 'string' && orgPattern.test(org))) throw new Error(`loop.org は組織名にしてください: ${JSON.stringify(org)}`);
  if (repos !== undefined && !(Array.isArray(repos) && repos.length && repos.every(repo => typeof repo === 'string' && repoPattern.test(repo)))) {
    throw new Error('loop.repos は owner/name を1つ以上並べた配列にしてください');
  }
  if (interval !== undefined && !(Number.isSafeInteger(interval) && interval >= 1)) throw new Error(`loop.interval は1以上の整数（分）にしてください: ${JSON.stringify(interval)}`);
}

// A missing file is an empty config, so every caller falls back to its own default.
export async function loadConfig() {
  const path = configPath();
  try {
    const text = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    });
    const config = JSON.parse(text);
    check(config);
    return config;
  } catch (error) {
    throw new Error(`設定ファイルに誤りがあります: ${path}（${error.message}）`);
  }
}

async function main() {
  const [command] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(help); return; }
  if (command !== 'loop') throw new Error(`未対応のコマンドです: ${command}`);
  const { org, repos = [], interval } = (await loadConfig()).loop ?? {};
  if (org !== undefined) console.log(`org ${org}`);
  for (const repo of repos) console.log(`repo ${repo}`);
  if (interval !== undefined) console.log(`interval ${interval}`);
}

// Node resolves symlinks for the entry module, so compare real paths (the skill dir is often a symlink).
if (process.argv[1] && realpathSync(process.argv[1]) === script) {
  await main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
