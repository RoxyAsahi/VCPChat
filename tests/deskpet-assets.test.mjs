import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createContentPipeline, PIPELINE_MODES } from '../modules/renderer/contentPipeline.js';

const require = createRequire(import.meta.url);
const handlers = require('../modules/ipc/deskPetHandlers.js');

const root = path.resolve('/vcp');
const paths = { projectRoot: root, appDataRoot: path.join(root, 'AppData'), agentDir: path.join(root, 'AppData', 'Agents') };
const resolve = (url) => handlers._resolveServedFile(url, paths);
const agentRoot = path.join(paths.agentDir, 'Nova');

test('desk pet protocol serves only the pet page, vendor, core and agent pet files', () => {
    assert.equal(resolve('vcp-deskpet://pet/app/deskpet.html'), path.join(root, 'DeskPetmodules', 'deskpet.html'));
    assert.equal(resolve('vcp-deskpet://pet/vendor/pixi.min.js'), path.join(root, 'vendor', 'pixi.min.js'));
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

test('chat display strips emo tags, including a half-streamed one, but leaves tool results alone', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /\[RESULT:[\s\S]*?\]/g,
        getToolRequestRegex: () => /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g,
        getCodeFenceRegex: () => /```[\s\S]*?```/g,
        processStartEndMarkers: (value) => value,
    });
    const full = pipeline.process('<!--emo:happy 0.8-->你好<!-- emo:shy/blush -->呀', { mode: PIPELINE_MODES.FULL_RENDER });
    assert.ok(!full.text.includes('emo:'));
    assert.ok(full.text.includes('你好') && full.text.includes('呀'));
    const stream = pipeline.process('你好<!--emo:hap', { mode: PIPELINE_MODES.STREAM_FAST });
    assert.ok(!stream.text.includes('<!--'));
    assert.ok(stream.text.includes('你好'));
});
