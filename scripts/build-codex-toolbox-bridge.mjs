import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    BRIDGE_MANIFEST_RELATIVE,
    developmentBridgePath,
} = require('../modules/codex-runtime/toolboxBridgePaths');

const repo = process.cwd();
const result = spawnSync('cargo', [
    'build', '--manifest-path', path.join(repo, BRIDGE_MANIFEST_RELATIVE),
    '--release', '-p', 'vcp-toolbox-bridge',
], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) process.exit(result.status || 1);
console.log(JSON.stringify({
    bridge: developmentBridgePath(repo),
    profile: 'release',
}));
