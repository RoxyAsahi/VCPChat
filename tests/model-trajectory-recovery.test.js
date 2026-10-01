const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createModelTrajectoryRecorder} = require('../modules/modelTrajectory');

function setup(t, options = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-recovery-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(rootDir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(rootDir).startsWith('trajectory-recovery-'));
        fs.rmSync(rootDir, {recursive:true, force:true});
    });
    return {rootDir, recorder:createModelTrajectoryRecorder({rootDir, ...options})};
}

test('retention removes only recorder-shaped orphan temporaries, including interrupted policy writes', async t => {
    const {rootDir, recorder} = setup(t);
    const orphan = recorder.fileOf('crashed') + '.tmp-0011223344556677';
    const policy = path.join(rootDir, 'record-policy.json.tmp-0011223344556677');
    const unrelated = path.join(rootDir, 'user.jsonl.tmp-0011223344556677');
    fs.writeFileSync(orphan, 'old sensitive body');
    fs.writeFileSync(policy, 'partial policy');
    fs.writeFileSync(unrelated, 'user-owned');
    await recorder.enforceRetention();
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(policy), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user-owned');
});

test('clearing a session removes its crashed-write body without touching another session temporary', async t => {
    const {recorder} = setup(t);
    const own = recorder.fileOf('own') + '.tmp-0011223344556677';
    const other = recorder.fileOf('other') + '.tmp-0011223344556677';
    fs.writeFileSync(own, 'own private body');
    fs.writeFileSync(other, 'other body');
    await recorder.clear('own');
    assert.equal(fs.existsSync(own), false);
    assert.equal(fs.readFileSync(other, 'utf8'), 'other body');
    assert.equal(fs.statSync(recorder.fileOf('own')).size, 0);
});

test('retention during an atomic write preserves the active temporary until commit', async t => {
    const {recorder} = setup(t);
    const promises = require('node:fs/promises');
    const originalWrite = promises.writeFile;
    let release, started;
    const gate = new Promise(resolve => {release = resolve;});
    const observed = new Promise(resolve => {started = resolve;});
    const prefix = recorder.fileOf('live') + '.tmp-';
    promises.writeFile = async (file, ...args) => {
        await originalWrite(file, ...args);
        if (String(file).startsWith(prefix)) {
            started(file);
            await gate;
        }
    };
    try {
        recorder.begin({sessionKey:'live', requestId:'durable-live'}).finish();
        const temp = await observed;
        await recorder.enforceRetention();
        assert.equal(fs.existsSync(temp), true);
        release();
        assert.equal((await recorder.list('live')).records[0].requestId, 'durable-live');
        assert.equal(fs.existsSync(temp), false);
    } finally {
        release();
        promises.writeFile = originalWrite;
        await recorder.list('live');
    }
});

test('clear markers survive expiry so recently copied legacy data cannot resurrect cleared history', async t => {
    let clock = Date.now();
    const {rootDir, recorder} = setup(t, {now:()=>clock, retentionDays:7});
    const legacy = path.join(rootDir, 'forgotten.jsonl');
    fs.writeFileSync(legacy, JSON.stringify({id:'old-private-record', sessionKey:'forgotten', startedAt:1}) + '\n');
    await recorder.clear('forgotten');
    clock += 8 * 86400000;
    fs.utimesSync(legacy, new Date(clock), new Date(clock));
    await recorder.enforceRetention();
    assert.equal(fs.existsSync(recorder.fileOf('forgotten')), true);
    const reopened = createModelTrajectoryRecorder({rootDir, now:()=>clock, retentionDays:7});
    assert.deepEqual((await reopened.list('forgotten')).records, []);
});
