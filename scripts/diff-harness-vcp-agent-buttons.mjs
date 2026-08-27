import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const vcp = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'vcp-agent-settings-production.json'), 'utf8'));
const harness = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/button.geometry.json'), 'utf8'));
const buttons = [ ...(vcp.actions ?? []), ...(vcp.promptButtons ?? []) ];
const expected = button => button.class?.includes('sm') ? harness.sizes.sm : harness.sizes.md;
const normalize = (property, value) => property === 'padding' && typeof value === 'string'
    ? value.replace(/(^|\s)0px(?=\s|$)/g, '$10')
    : value;
const checks = buttons.map(button => {
    const size = expected(button);
    const style = button.style ?? {};
    const properties = [
        ['display', style.display, 'inline-flex'],
        ['gap', style.gap, harness.root.gap],
        ['height', style.height, size.height],
        ['padding', style.padding, size.padding ?? harness.root.padding],
        ['borderRadius', style.borderRadius, size.borderRadius ?? harness.root.borderRadius],
        ['fontSize', style.fontSize, size.fontSize ?? harness.root.fontSize],
        ['lineHeight', style.lineHeight, size.lineHeight ?? harness.root.lineHeight],
    ];
    return {
        controlId: button.controlId ?? null,
        class: button.class,
        checks: properties.map(([property, actual, expectedValue]) => ({ property, actual, expected: expectedValue, pass: normalize(property, actual) === normalize(property, expectedValue) })),
        authoredDisplayRulePass: style.displayRules?.some(rule => rule.selector === '.vcp-harness-button.button' && rule.display === 'inline-flex') === true,
    };
});
const report = {
    source: 'DeepSeek Harness button.geometry.json + VCP production Agent Settings capture',
    viewport: vcp.viewport,
    capturedButtonCount: buttons.length,
    perButton: checks,
    authoredContractPass: checks.every(button => button.authoredDisplayRulePass),
    computedGeometryPass: checks.every(button => button.checks.every(check => check.pass)),
    status: checks.every(button => button.checks.every(check => check.pass)) ? 'partial-contract-equivalent' : 'computed-style-mismatch',
    note: 'This is a geometry contract report only; it does not prove DOM structural or pixel equivalence.',
};
fs.writeFileSync(path.join(root, 'reports', 'harness-vcp-agent-buttons-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
