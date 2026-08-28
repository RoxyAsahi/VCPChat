// Appearance section primitive mounting. The native selects remain the
// canonical business controls; this helper owns only generated presentation.
export function mountAppearanceSelects(form, api, scope) {
    if (!form || !scope || !api?.mountSelect) return;
    const fields = [
        ['appearanceDensity', '界面密度'],
        ['appearanceRadius', '圆角风格'],
        ['appearanceTypography', '界面字体'],
        ['appearanceFontScale', '界面字号'],
        ['appearanceContentWidth', '内容宽度'],
        ['appearanceSurface', '页面材质'],
    ];
    fields.forEach(([id, label]) => {
        const select = form.querySelector(`#${id}`);
        if (!select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        if (api.mountField && select.parentElement) api.mountField(select.parentElement, { label, control: select }, scope);
        api.mountSelect(select, { label, portal: true }, scope);
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
    });
}

export function mountAppearanceRadiusLanguageRow(form, api, scope) {
    const host = form?.querySelector('#appearanceSidebarRadiusLanguageRow');
    const select = form?.querySelector('#appearanceSidebarRadius');
    if (!host || !select || !scope || !api?.mountLanguageRow || host.dataset.vcpTypedPrimitiveMounted === 'true') return;
    const options = Array.from(select.options).map(option => ({ id: option.value, label: option.textContent || option.value }));
    const row = api.mountLanguageRow(host, {
        title: '列表项圆角',
        description: '控制助手、话题和账户列表项的圆角',
        options,
        activeId: select.value,
        onSelect: id => {
            select.value = id;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        },
    }, scope);
    host.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete host.dataset.vcpTypedPrimitiveMounted; }, 'typed-radius-language-row-marker', 'ui-primitive');
    scope.own(() => row.dispose(), 'typed-radius-language-row', 'ui-primitive');
}
