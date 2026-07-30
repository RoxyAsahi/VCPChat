import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustSourceRevision } from './rust-source-revision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustDir = path.join(root, 'rust');
const manifest = path.join(rustDir, 'Cargo.toml');
const profileFlagIndex = process.argv.indexOf('--profile');
const profile = profileFlagIndex >= 0 ? process.argv[profileFlagIndex + 1] : 'release';
if (!profile || !/^[a-z0-9-]+$/.test(profile)) {
    throw new Error('build-rust-daemon --profile must be followed by a Cargo profile name');
}
const targetDir = process.env.VCP_AGENT_CARGO_TARGET_DIR
    ? path.resolve(root, process.env.VCP_AGENT_CARGO_TARGET_DIR)
    : path.join(rustDir, 'target');
const executable = path.join(targetDir, profile, process.platform === 'win32' ? 'vcp-agentd.exe' : 'vcp-agentd');

if (!fs.existsSync(manifest)) {
    throw new Error(`Rust source not found at ${rustDir}. Expected rust/ directory alongside package.json.`);
}

const revision = rustSourceRevision(root);
const build = spawnSync(process.platform === 'win32' ? 'cargo.exe' : 'cargo', ['build', '--manifest-path', manifest, '--target-dir', targetDir, '--profile', profile, '-p', 'vcp-agentd'], {
    cwd: root,
    env: { ...process.env, VCP_AGENT_BUILD_REVISION: revision },
    stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status || 1);
if (!fs.existsSync(executable)) throw new Error(`daemon build finished without output: ${executable}`);

const artifact = fs.statSync(executable);
console.log(JSON.stringify({
    daemon: executable,
    profile,
    revision,
    bytes: artifact.size,
    builtAt: artifact.mtime.toISOString(),
}, null, 2));
