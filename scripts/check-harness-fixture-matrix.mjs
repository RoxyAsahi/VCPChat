import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const file = path.join(root, 'docs/reference/deepseek-harness-primitives/fixture-matrix.json');
const matrix = JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = message => { throw new Error(`[harness-fixture-matrix] ${message}`); };
if (matrix.viewport?.width !== 800 || matrix.viewport?.height !== 600 || matrix.viewport?.deviceScaleFactor !== 1) fail('viewport must remain 800x600 @1x');
if (matrix.font !== 'system-ui') fail('font baseline must remain system-ui');
if (!Array.isArray(matrix.cases) || matrix.cases.length !== 10) fail('expected exactly 10 primitive state cases');
for (const [primitive, state] of matrix.cases) if (!['input', 'field', 'select'].includes(primitive) || typeof state !== 'string') fail(`invalid case ${primitive}/${state}`);
for (const output of ['dom', 'geometry', 'computed-style', 'screenshot', 'pixel-diff']) if (!matrix.outputs.includes(output)) fail(`missing output layer ${output}`);
if (matrix.stateSemantics?.['select/closed'] !== 'AgentPresetSeat ready trigger; production fixture pending') fail('Select closed state must retain its Agent Preset production-fixture boundary');
if (matrix.stateSemantics?.['select/disabled'] !== 'MenuItem.disabled source/DOM fixture only; AgentPresetSeat busy trigger production fixture is pending') fail('Select disabled state must distinguish Menu source evidence from the pending Agent Preset busy trigger');
if (matrix.status?.domStructural !== '10/10 pass') fail('DOM structural checkpoint must remain explicit');
if (matrix.status?.selectMenuOpenSelectedHoverPixel !== 'pass (menu ROI only)') fail('Select pixel checkpoint must remain ROI-scoped');
if (matrix.status?.fieldBrowserVisual !== 'pass (description/error production fixture at 1680x1000 @1x)') fail('Field browser evidence must remain scoped to its production fixture');
if (matrix.status?.inputFullVisualMatrix !== 'blocked (Harness ui-primitives/Input has no production consumer)') fail('Input status must distinguish an absent production consumer from visual completion');
console.log(`Harness fixture matrix passed (${matrix.cases.length} cases; ${matrix.outputs.length} output layers; DOM=${matrix.status.domStructural}; Field browser=${matrix.status.fieldBrowserVisual}).`);
