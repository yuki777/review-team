#!/usr/bin/env node
import { access, lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = `使い方: node install.mjs [--home <絶対パス>] [--help]

review-triple を次の二か所へシンボリックリンクで登録します。
  ~/.claude/skills/review-triple
  ~/.agents/skills/review-triple

--home <絶対パス>  登録先のホームを指定（既定: 現在のユーザーのホーム）
--help             この説明だけを表示し、ファイルを変更しません

同じスキルを指す既存リンクは変更しません。
別のリンク・ファイル・ディレクトリは上書きしません。
Node.js 22 以降と POSIX 環境が必要です。`;

function parseHome(args) {
  let home = homedir();
  let supplied = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--home') {
      throw new Error(`不明な引数: ${args[i]}`);
    }
    if (supplied) {
      throw new Error('--home は一度だけ指定してください');
    }
    const value = args[i + 1];
    if (!value || !isAbsolute(value)) {
      throw new Error('--home には絶対パスを指定してください');
    }
    home = resolve(value);
    supplied = true;
    i += 1;
  }
  return home;
}

async function alreadyInstalled(destination, source) {
  let entry;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    try {
      if (await realpath(destination) === source) return true;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'ELOOP') {
        throw error;
      }
    }
  }
  throw new Error(`既存の登録先を上書きしません: ${destination}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }

  let home;
  try {
    home = parseHome(args);
  } catch (error) {
    console.error(error.message);
    console.error('使い方は --help を参照してください');
    process.exitCode = 2;
    return;
  }

  try {
    if (Number(process.versions.node.split('.')[0]) < 22) {
      throw new Error('Node.js 22 以降が必要です');
    }
    if (process.platform === 'win32') {
      throw new Error('POSIX 環境が必要です');
    }
    const source = await realpath(fileURLToPath(new URL('../', import.meta.url)));
    await access(join(source, 'SKILL.md'));
    const destinations = [
      join(home, '.claude', 'skills', 'review-triple'),
      join(home, '.agents', 'skills', 'review-triple'),
    ];

    // 既知の衝突は、どちらの登録先も変更する前に拒否する。
    const installed = [];
    for (const destination of destinations) {
      installed.push(await alreadyInstalled(destination, source));
    }

    for (let i = 0; i < destinations.length; i += 1) {
      const destination = destinations[i];
      if (installed[i]) {
        console.log(`登録済み: ${destination}`);
        continue;
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await symlink(source, destination, 'dir');
        console.log(`登録しました: ${destination}`);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 同時に登録されても置換しない。同一リンクなら成功とする。
        if (!await alreadyInstalled(destination, source)) throw error;
        console.log(`登録済み: ${destination}`);
      }
    }
  } catch (error) {
    console.error(`インストール失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
