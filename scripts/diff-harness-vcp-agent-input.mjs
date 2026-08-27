import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportPath = path.join(root, 'reports', 'vcp-agent-settings-production.json');
const harnessCssPath = '/Users/asahi/Documents/Codex/deepseek-harness/packages/client/ui-primitives/src/Input.module.css';
assert.ok(fs.existsSync(reportPath), 'VCP Agent Settings production capture is required');
assert.ok(fs.existsSync(harnessCssPath), 'DeepSeek Harness Input source is required');
const vcp = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const harnessCss = fs.readFileSync(harnessCssPath, 'utf8');
const wrapper = vcp.inputs?.[0]?.style;
const input = vcp.inputNodes?.[0]?.style;
assert.ok(wrapper && input, 'VCP Agent Input capture is incomplete');

const checks = [
    ['wrapper.display', wrapper.display, 'inline-flex|flex', /\.wrap\s*\{[\s\S]*display:\s*inline-flex/],
    ['wrapper.gap', wrapper.gap, '6px', /\.wrap\s*\{[\s\S]*gap:\s*6px/],
    ['wrapper.height', wrapper.height, '32px', /\.wrap\s*\{[\s\S]*height:\s*32px/],
    ['wrapper.padding', wrapper.padding, '0px 8px', /\.wrap\s*\{[\s\S]*padding:\s*0\s+8px/],
    ['wrapper.borderRadius', wrapper.borderRadius, '8px', /\.wrap\s*\{[\s\S]*border-radius:\s*8px/],
    ['input.padding', input.padding, '0px 10px', null],
    ['input.fontSize', input.fontSize, '14px', /\.input\s*\{[\s\S]*font-size:\s*14px/],
    ['input.lineHeight', input.lineHeight, '22px', /\.input\s*\{[\s\S]*line-height:\s*22px/],
];
const contract = checks.map(([property, actual, expected, source]) => ({
    property, expected, actual, sourcePresent: source ? source.test(harnessCss) : 'unspecified',
    pass: (property === 'wrapper.display' ? /^(inline-flex|flex)$/.test(actual) : actual === expected) && (source ? source.test(harnessCss) : true),
}));
const report = {
    source: 'Harness Input.module.css + VCP production Agent Settings capture',
    viewport: vcp.viewport,
    contract,
    wrapperContractPass: contract.filter(item => item.property.startsWith('wrapper.')).every(item => item.pass),
    inputContractPass: contract.filter(item => item.property.startsWith('input.')).every(item => item.pass),
    status: 'partial-contract-equivalent',
    note: 'This compares the shared Input contract only; Agent Settings remains a larger legacy Surface and is not pixel-equivalent as a whole.',
};
fs.writeFileSync(path.join(root, 'reports', 'harness-vcp-agent-input-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
