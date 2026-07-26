'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron');
const root = path.resolve(__dirname, '..');
const result = spawnSync(electron, ['scripts/test-agent-persistence.mjs'], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
