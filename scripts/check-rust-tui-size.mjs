import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileFlagIndex = process.argv.indexOf('--profile');
const profile = profileFlagIndex >= 0 ? process.argv[profileFlagIndex + 1] : 'release';
if (!profile || !/^[a-z0-9-]+$/.test(profile)) {
  throw new Error('check-rust-tui-size --profile must be followed by a Cargo profile name');
}
const binaryPath = path.join(repoRoot, 'rust', 'target', profile, 'vcp-agent.exe');
const baselineBytes = 6_380_032;
const defaultLimitBytes = 18_962_944;
const limitBytes = Number.parseInt(
  process.env.VCP_AGENT_TUI_SIZE_LIMIT_BYTES || String(defaultLimitBytes),
  10,
);

if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
  throw new Error('VCP_AGENT_TUI_SIZE_LIMIT_BYTES must be a positive integer');
}

const { size } = await stat(binaryPath);
const delta = size - baselineBytes;
console.log(
  '[vcp-agent-size] binary=' + binaryPath
    + ' profile=' + profile
    + ' size=' + size
    + ' baseline=' + baselineBytes
    + ' delta=' + delta
    + ' limit=' + limitBytes,
);
if (size > limitBytes) {
  throw new Error('vcp-agent.exe exceeds release size gate by ' + (size - limitBytes) + ' bytes');
}
