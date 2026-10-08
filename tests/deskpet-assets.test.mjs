import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handlers = require('../modules/ipc/deskPetHandlers.js');

const root = path.resolve('/vcp');
const paths = { projectRoot: root, appDataRoot: path.join(root, 'AppData'), agentDir: path.join(root, 'AppData', 'Agents') };
const resolve = (url) => handlers._resolveServedFile(url, paths);
const agentRoot = path.join(paths.agentDir, 'Nova');

test('desk pet protocol serves only the pet page, vendor, core and agent pet files', () => {
    assert.equal(resolve('vcp-deskpet://pet/app/deskpet.html'), path.join(root, 'DeskPetmodules', 'deskpet.html'));
    assert.equal(resolve('vcp-deskpet://pet/vendor/pixi.min.js'), path.join(root, 'vendor', 'pixi.min.js'));
    assert.equal(resolve('vcp-deskpet://pet/emotion/emotionDirector.js'), path.join(root, 'modules', 'emotion', 'emotionDirector.js'));
    assert.equal(resolve('vcp-deskpet://pet/core/live2dcubismcore.min.js'), path.join(paths.appDataRoot, 'deskpet', 'live2dcubismcore.min.js'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/deskpet/Mao/Mao.model3.json'), path.join(agentRoot, 'deskpet', 'Mao', 'Mao.model3.json'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/portrait.happy.png'), path.join(agentRoot, 'portrait.happy.png'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/avatar.png'), path.join(agentRoot, 'avatar.png'));
});

test('desk pet protocol refuses agent config, history and traversal', () => {
    for (const url of [
        'vcp-deskpet://pet/agent/Nova/config.json',
        'vcp-deskpet://pet/agent/Nova/topics/t1/history.json',
        'vcp-deskpet://pet/agent/Nova/deskpet/..%2Fconfig.json',
        'vcp-deskpet://pet/agent/Nova/deskpet/..%5Cconfig.json',
        'vcp-deskpet://pet/agent/..%2F..%2Fsettings.json/deskpet/x',
        'vcp-deskpet://pet/app/..%2Fmain.js',
        'vcp-deskpet://pet/emotion/..%2F..%2Fmain.js',
        'vcp-deskpet://pet/core/other.js',
        'vcp-deskpet://pet/settings.json',
        'vcp-deskpet://pet/agent/Nova/deskpet/%E0%A4%A',
    ]) {
        assert.equal(resolve(url), null, url);
    }
});

test('desk pet protocol prompt is only appended while that agent has a pet open', () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    assert.equal(handlers.appendProtocolToMessages(messages, 'Nova'), messages);
});
