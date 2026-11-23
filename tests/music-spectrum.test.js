const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 频谱检查：FFT 对、能找到有损编码留下的高频切口、按切口给结论。
const { fft, spectrumColumns, findCutoff, verdict } = require(path.join(__dirname, '../Musicmodules/music-spectrum.js'));

test('fft finds a pure tone in the right bin', () => {
    const n = 1024;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 50 * i / n);
    fft(re, im);
    let best = 0;
    for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
    assert.equal(best, 50);
});

// 白噪声（像音乐一样连续的宽带内容），maxHz 小于奈奎斯特时用加窗 sinc 低通砍掉高频（像有损编码那样）
function signal(maxHz, sampleRate = 44100, seconds = 3) {
    const n = sampleRate * seconds;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) noise[i] = 0.2 * rnd();
    if (maxHz >= sampleRate / 2) return noise;
    const taps = 255;
    const fc = maxHz / sampleRate;
    const h = new Float32Array(taps);
    for (let i = 0; i < taps; i++) {
        const m = i - (taps - 1) / 2;
        const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1)));
    }
    const out = new Float32Array(n);
    for (let i = taps; i < n; i++) { let v = 0; for (let k = 0; k < taps; k++) v += h[k] * noise[i - k]; out[i] = v; }
    return out;
}

test('a 16 kHz low-pass is found; full-band content has no cutoff', () => {
    const cut = spectrumColumns([signal(16000)], { columns: 40 });
    const c = findCutoff(cut.average, 44100);
    assert.ok(c > 15500 && c < 16600, 'cutoff near 16k: ' + c);
    assert.equal(verdict({ cutoff: c, sampleRate: 44100, lossless: true }).level, 'warn');
    const full = spectrumColumns([signal(22050)], { columns: 40 });
    assert.equal(findCutoff(full.average, 44100), 0);
    assert.equal(verdict({ cutoff: 0, sampleRate: 44100, lossless: true }).level, 'good');
});

test('verdict wording by cutoff and format', () => {
    assert.match(verdict({ cutoff: 20600, sampleRate: 44100, lossless: true }).text, /320/);
    assert.match(verdict({ cutoff: 19900, sampleRate: 44100, lossless: true }).text, /256/);
    assert.match(verdict({ cutoff: 18800, sampleRate: 44100, lossless: true }).text, /192/);
    assert.match(verdict({ cutoff: 16700, sampleRate: 44100, lossless: true }).text, /128/);
    assert.equal(verdict({ cutoff: 21500, sampleRate: 44100, lossless: true }).level, 'good');
    assert.match(verdict({ cutoff: 16500, sampleRate: 96000, lossless: true }).text, /128 kbps.*高采样率/);
    assert.match(verdict({ cutoff: 22000, sampleRate: 96000, lossless: true }).text, /升上来/);
    assert.equal(verdict({ cutoff: 16000, sampleRate: 44100, lossless: false }).level, 'info');
    assert.equal(verdict({ cutoff: 0, sampleRate: 96000, lossless: true }).level, 'good');
});
