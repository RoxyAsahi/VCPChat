const animationState = new WeakMap();

function processAnimationsInContent(content) {
    if (!content) return;
    // Agent transcript HTML is presentation data. It may use CSS/Web Animations,
    // but it never receives an executable script channel from model output.
    for (const script of content.querySelectorAll('script')) script.remove();
    const animations = [];
    try { animations.push(...(content.getAnimations?.({ subtree: true }) || [])); } catch {}
    animationState.set(content, animations);
}

function cleanupAnimationsInContent(content) {
    if (!content) return;
    const animations = animationState.get(content) || [];
    for (const animation of animations) {
        try { animation.cancel(); } catch {}
    }
    animationState.delete(content);
    for (const media of content.querySelectorAll('video, audio')) {
        try { media.pause(); } catch {}
        media.removeAttribute('src');
        media.load?.();
    }
}

export { cleanupAnimationsInContent, processAnimationsInContent };
