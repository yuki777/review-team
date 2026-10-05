import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../skills/review-team/scripts/diff-lines.mjs', import.meta.url).pathname;

const diff = `diff --git a/a.js b/a.js
index 1111111..2222222 100644
--- a/a.js
+++ b/a.js
@@ -10,3 +10,3 @@ function f() {
 ctx10
-old11
+new11
 ctx12
@@ -20 +20,2 @@
 ctx20
+added21
\\ No newline at end of file
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.md b/gone.md
deleted file mode 100644
--- a/gone.md
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git "a/\\346\\227\\245.md" "b/\\346\\227\\245.md"
--- "a/\\346\\227\\245.md"
+++ "b/\\346\\227\\245.md"
@@ -1 +1 @@
-古い
+新しい
`;

const edgeDiff = `diff --git a/old.js b/new.js
similarity index 90%
rename from old.js
rename to new.js
--- a/old.js
+++ b/new.js
@@ -1,4 +1,4 @@
 keep

--- dashes
+++ pluses

diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/crlf.txt b/crlf.txt
--- a/crlf.txt
+++ b/crlf.txt
@@ -1 +1 @@
-a\r
+b\r
diff --git "a/x\\rz\\360\\237\\230\\200.js" "b/x\\rz\\360\\237\\230\\200.js"
--- "a/x\\rz\\360\\237\\230\\200.js"
+++ "b/x\\rz😀\\t.js"
@@ -1 +1 @@
-c
+d
`;

const run = async (input, ...args) => {
  const dir = await mkdtemp(join(tmpdir(), 'review-team-test-'));
  await writeFile(join(dir, 'reviewed.diff'), input);
  const out = execFileSync(process.execPath, [script, join(dir, 'reviewed.diff'), ...args], { encoding: 'utf8' });
  await rm(dir, { recursive: true, force: true });
  return out.split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('reviewed.diffからコメントを置ける行を、古い行と新しい行の番号を分けて数えて一覧にする', async () => {
  assert.deepEqual(await run(diff), [
    { path: 'a.js', hunk: 1, side: 'RIGHT', line: 10, text: 'ctx10' },
    { path: 'a.js', hunk: 1, side: 'LEFT', line: 11, text: 'old11' },
    { path: 'a.js', hunk: 1, side: 'RIGHT', line: 11, text: 'new11' },
    { path: 'a.js', hunk: 1, side: 'RIGHT', line: 12, text: 'ctx12' },
    { path: 'a.js', hunk: 2, side: 'RIGHT', line: 20, text: 'ctx20' },
    { path: 'a.js', hunk: 2, side: 'RIGHT', line: 21, text: 'added21' },
    { path: 'new.md', hunk: 1, side: 'RIGHT', line: 1, text: 'one' },
    { path: 'new.md', hunk: 1, side: 'RIGHT', line: 2, text: 'two' },
    { path: 'gone.md', hunk: 1, side: 'LEFT', line: 1, text: 'bye' },
    { path: '日.md', hunk: 1, side: 'LEFT', line: 1, text: '古い' },
    { path: '日.md', hunk: 1, side: 'RIGHT', line: 1, text: '新しい' },
  ]);
});

test('--pathで一つのファイルに絞る', async () => {
  assert.deepEqual((await run(diff, '--path', 'new.md')).map(row => row.line), [1, 2]);
  assert.deepEqual(await run(diff, '--path', 'missing.md'), []);
});

test('リネーム・空の文脈行・記号で始まる行・CRLF・エスケープされたパスを正しく読み、バイナリとモード変更は行を出さない', async () => {
  assert.deepEqual(await run(edgeDiff), [
    { path: 'new.js', hunk: 1, side: 'RIGHT', line: 1, text: 'keep' },
    { path: 'new.js', hunk: 1, side: 'RIGHT', line: 2, text: '' },
    { path: 'new.js', hunk: 1, side: 'LEFT', line: 3, text: '-- dashes' },
    { path: 'new.js', hunk: 1, side: 'RIGHT', line: 3, text: '++ pluses' },
    { path: 'new.js', hunk: 1, side: 'RIGHT', line: 4, text: '' },
    { path: 'crlf.txt', hunk: 1, side: 'LEFT', line: 1, text: 'a\r' },
    { path: 'crlf.txt', hunk: 1, side: 'RIGHT', line: 1, text: 'b\r' },
    { path: 'x\rz😀\t.js', hunk: 1, side: 'LEFT', line: 1, text: 'c' },
    { path: 'x\rz😀\t.js', hunk: 1, side: 'RIGHT', line: 1, text: 'd' },
  ]);
  assert.deepEqual(await run(edgeDiff, '--path', 'x\rz😀\t.js'), [
    { path: 'x\rz😀\t.js', hunk: 1, side: 'LEFT', line: 1, text: 'c' },
    { path: 'x\rz😀\t.js', hunk: 1, side: 'RIGHT', line: 1, text: 'd' },
  ]);
});
