import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// On macOS, watch-pr.mjs record and defer write a plist under homedir() and run launchctl.
// bootout unloads a job by its label wherever its plist is, so a temporary HOME alone would still stop the tick of
// whoever runs the tests: launchctl is replaced as well, by one in <dir>/bin that does nothing.
// Returns env with both replaced. <dir>/bin must exist and come first in env.PATH.
export async function withoutLaunchd(dir, env) {
  const launchctl = join(dir, 'bin', 'launchctl');
  await writeFile(launchctl, '#!/bin/sh\nexit 0\n');
  await chmod(launchctl, 0o755);
  await mkdir(join(dir, 'home'));
  const isolated = { ...env, HOME: join(dir, 'home') };
  // A file that cannot be run is passed over in the PATH search, which would then reach the real launchctl.
  const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v launchctl'], { env: isolated });
  assert.equal(stdout.trim(), launchctl);
  return isolated;
}
