// 加载暂存的 Cubism Core，把 csmGetVersion() 写进标题：core-version:<数字>，加载不了是 0。
(function probe() {
    const report = (version) => { document.title = `core-version:${version}`; };
    const script = document.createElement('script');
    script.src = 'vcp-deskpet://pet/core/staged.js';
    script.onload = () => {
        let version = 0;
        try { version = Number(window.Live2DCubismCore?.Version?.csmGetVersion?.()) || 0; } catch { version = 0; }
        report(version);
    };
    script.onerror = () => report(0);
    document.head.appendChild(script);
}());
