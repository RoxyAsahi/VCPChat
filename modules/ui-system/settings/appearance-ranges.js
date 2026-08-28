// Appearance Range primitive mounting. Native range inputs remain canonical.
export function mountAppearanceRanges(form, api, scope) {
    if (!form || !scope || !api?.mountRange) return;
    [['appearanceSidebarAvatarSize', 'appearanceSidebarAvatarSizeValue'],
        ['appearanceSidebarRowHeight', 'appearanceSidebarRowHeightValue'],
        ['appearanceCustomRadius', 'appearanceCustomRadiusValue']].forEach(([id, outputId]) => {
        const input = form.querySelector(`#${id}`);
        const output = form.querySelector(`#${outputId}`);
        if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountRange(input, { output, format: value => `${value}px` }, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
    });
}
