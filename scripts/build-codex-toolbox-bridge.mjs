import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repo = process.cwd();
const result = spawnSync('cargo', [
    'build', '--manifest-path', path.join(repo, 'rust', 'Cargo.toml'),
    '--release', '-p', 'vcp-toolbox-bridge',
], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) process.exit(result.status || 1);
console.log(JSON.stringify({
    bridge: path.join(repo, 'rust', 'target', 'release', process.platform === 'win32' ? 'vcp-toolbox-bridge.exe' : 'vcp-toolbox-bridge'),
    profile: 'release',
}));
