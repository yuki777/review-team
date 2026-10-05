#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const usage = '使い方: diff-lines.mjs <reviewed.diff> [--path <ファイル>]';

const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

// git quotes paths containing special bytes as C strings with octal escapes.
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const src = Buffer.from(path.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== 0x5c) { bytes.push(src[i]); continue; }
    const next = String.fromCharCode(src[++i]);
    if (/[0-7]/.test(next)) { bytes.push(parseInt(src.subarray(i, i + 3).toString(), 8)); i += 2; continue; }
    bytes.push(escapes[next] ?? src[i]);
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(line) {
  const path = unquote(line.slice(4).replace(/\t$/, ''));
  return path === '/dev/null' ? null : path.slice(2);
}

function diffLines(text) {
  const rows = [];
  let oldPath = null, path = null, hunk = 0, oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  for (const line of text.split('\n')) {
    // The hunk header's line counts decide where the hunk ends, so body lines such as "--- x" or an empty context line are not misread.
    if ((oldLeft > 0 || newLeft > 0) && !line.startsWith('diff --git ')) {
      const body = line.slice(1);
      if (line[0] === ' ' || line === '') { rows.push({ path, hunk, side: 'RIGHT', line: newLine, text: body }); oldLine++; newLine++; oldLeft--; newLeft--; }
      else if (line[0] === '-') { rows.push({ path, hunk, side: 'LEFT', line: oldLine++, text: body }); oldLeft--; }
      else if (line[0] === '+') { rows.push({ path, hunk, side: 'RIGHT', line: newLine++, text: body }); newLeft--; }
      continue;
    }
    oldLeft = newLeft = 0;
    if (line.startsWith('diff --git ')) { hunk = 0; continue; }
    if (line.startsWith('--- ')) { oldPath = headerPath(line); continue; }
    if (line.startsWith('+++ ')) { path = headerPath(line) ?? oldPath; continue; }
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) continue;
    hunk++;
    [oldLine, oldLeft, newLine, newLeft] = [header[1], header[2] ?? 1, header[3], header[4] ?? 1].map(Number);
  }
  return rows;
}

const { values, positionals } = parseArgs({ options: { path: { type: 'string' } }, allowPositionals: true });
if (positionals.length !== 1) { console.error(usage); process.exit(2); }
for (const row of diffLines(await readFile(positionals[0], 'utf8'))) {
  if (!values.path || row.path === values.path) console.log(JSON.stringify(row));
}
