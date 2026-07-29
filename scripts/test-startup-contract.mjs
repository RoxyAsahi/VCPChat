import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const main = read('main.js');
const loadWindowStart = main.indexOf('function loadMainWindow()');
const loadWindowEnd = main.indexOf('\nfunction createTray()', loadWindowStart);
const loadWindow = main.slice(loadWindowStart, loadWindowEnd);
assert.ok(loadWindow.includes("webContents.once('did-finish-load'"), 'main window must retain an explicit ready event');
assert.ok(loadWindow.indexOf('mainWindow.show();') < loadWindow.indexOf('signalNativeSplashReady();'), 'the splash marker must be emitted after the main window is visible');
assert.ok(loadWindow.includes("webContents.once('did-fail-load'"), 'failed renderer loads must release the native splash');

const lockFailureStart = main.indexOf('if (!gotTheLock)');
const lockFailureEnd = main.indexOf('} else {', lockFailureStart);
assert.ok(lockFailureStart >= 0 && lockFailureEnd > lockFailureStart, 'single-instance branches must be present');
assert.ok(!main.slice(lockFailureStart, lockFailureEnd).includes('signalNativeSplashReady()'), 'the short-lived second process must not release a cold-start splash');
assert.ok(main.includes('mainWindow.isVisible()'), 'the primary instance must only release a second-launch splash after it is visible');

const batch = read('start.bat');
assert.ok(batch.includes('cd /d "%~dp0"'), 'batch launcher must run from its project directory');
assert.ok(batch.includes('START "" /D "%~dp0" "NativeSplash.exe"'), 'batch splash must receive the project working directory');

for (const launcher of ['启动Vchat.vbs', '启动全部.vbs']) {
    assert.ok(read(launcher).includes('WshShell.CurrentDirectory = projectPath'), `${launcher} must run NativeSplash from the project directory`);
}

console.log('Startup launcher and splash ownership contract passed.');
