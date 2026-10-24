import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') {
  process.stderr.write('Skipping Apple Calendar bridge build: macOS is required.\n');
  process.exit(0);
}

const bundle = resolve(root, 'dist/native/LocalDevLogCalendarBridge.app');
const contents = resolve(bundle, 'Contents');
const executableDirectory = resolve(contents, 'MacOS');
const executable = resolve(executableDirectory, 'LocalDevLogCalendarBridge');
await rm(bundle, { recursive: true, force: true });
await mkdir(executableDirectory, { recursive: true });
await cp(resolve(root, 'native/calendar-bridge/Info.plist'), resolve(contents, 'Info.plist'));

const compile = spawnSync('xcrun', [
  'swiftc',
  '-parse-as-library',
  resolve(root, 'native/calendar-bridge/main.swift'),
  '-framework', 'EventKit',
  '-o', executable,
], {
  cwd: root,
  env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '14.0' },
  encoding: 'utf8',
});
if (compile.status !== 0) {
  process.stderr.write(compile.stderr || 'Swift Calendar bridge compilation failed.\n');
  process.exit(compile.status ?? 1);
}

const sign = spawnSync('/usr/bin/codesign', [
  '--force', '--sign', '-', '--identifier', 'dev.local-devlog-mcp.calendar-bridge', bundle,
], { cwd: root, encoding: 'utf8' });
if (sign.status !== 0) {
  process.stderr.write(sign.stderr || 'Calendar bridge code signing failed.\n');
  process.exit(sign.status ?? 1);
}
