import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const vcp = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'vcp-agent-settings-production.json'), 'utf8'));
const harness = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/button.geometry.json'), 'utf8'));
// The model trigger is owned by AgentModelPicker, not the generic Button
// primitive. Exclude it from this Button-only contract report so its distinct
// 28px/24px picker geometry is not reported as a false Button mismatch.
const buttons = [ ...(vcp.actions ?? []).filter(button => button.controlId !== 'openModelSelectBtn'), ...(vcp.promptButtons ?? []) ];
const expected = button => button.class?.includes('sm') ? harness.sizes.sm : harness.sizes.md;
const normalize = (property, value) => property === 'padding' && typeof value === 'string'
    ? value.replace(/(^|\s)0px(?=\s|$)/g, '$10')
    : value;
const checks = buttons.map(button => {
    const size = expected(button);
    const style = button.style ?? {};
    const authoredInlineFlex = style.authored?.inline?.display === 'inline-flex'
        || style.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') === true;
    const properties = [
        // Native Chromium serializes inline-flex buttons as `flex` in some
        // layout contexts. The authored rule is the source contract; record
        // computed serialization separately rather than treating it as a
        // geometry regression.
        ['computedDisplay', style.display, 'inline-flex|flex', ['inline-flex', 'flex'].includes(style.display)],
        ['authoredDisplay', authoredInlineFlex, true, authoredInlineFlex],
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
        checks: properties.map(([property, actual, expectedValue, explicitPass]) => ({ property, actual, expected: expectedValue, pass: explicitPass ?? (normalize(property, actual) === normalize(property, expectedValue)) })),
        authoredDisplayRulePass: authoredInlineFlex,
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
