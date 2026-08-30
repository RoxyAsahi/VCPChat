import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportPath = path.join(root, 'reports/harness-select-trigger-busy.json');
const fail = message => { throw new Error(`[harness-select-busy-evidence] ${message}`); };
if (!fs.existsSync(reportPath)) fail('run npm run capture:harness-select-busy-fixture before checking evidence');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (report.source !== 'Harness production web agent-preset seat with delayed host select') fail('source must remain the production AgentPresetSeat route');
if (report.semanticFixture !== 'agent-preset-selection/blank session/Minimal mode/busy-trigger-disabled') fail('fixture must identify the real blank-session busy trigger');
if (report.state !== 'busy-trigger-disabled') fail('state must remain busy-trigger-disabled');
if (report.viewport?.width !== 800 || report.viewport?.height !== 600 || report.viewport?.deviceScaleFactor !== 1) fail('capture must remain 800x600 @1x');
if (report.disabled !== true || !String(report.dom).includes('disabled')) fail('captured AgentPresetSeat trigger must be disabled');
if (report.rect?.width <= 0 || report.rect?.height <= 0) fail('captured trigger requires measurable geometry');
if (report.style?.borderRadius !== '16px' || report.style?.gap !== '4px' || report.style?.padding !== '0px 8px') fail('captured trigger geometry must retain Harness seat styling');
console.log(`Harness Select busy trigger evidence passed (${report.semanticFixture}; ${report.rect.width}x${report.rect.height}).`);
