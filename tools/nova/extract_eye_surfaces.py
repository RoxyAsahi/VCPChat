"""Extract original native white/iris layers without compositing or resizing."""
import sys
from pathlib import Path
from psd_tools import PSDImage

if len(sys.argv) != 4:
    raise SystemExit("Usage: python -I extract_eye_surfaces.py <original PSD> <tech|maid> <output directory>")
outfit = sys.argv[2]
assert outfit in ('tech', 'maid'), outfit
output = Path(sys.argv[3]).resolve()
output.mkdir(parents=True, exist_ok=True)
psd = PSDImage.open(sys.argv[1])
expected = {'eyewhite-l', 'eyewhite-r', 'irides-l', 'irides-r'}
selected = [layer for layer in psd.descendants() if layer.name in expected]
assert {layer.name for layer in selected} == expected
for layer in selected:
    layer.topil().convert('RGBA').save(output / f'{outfit}-{layer.name}.png')
print(f'Extracted {len(selected)} original layers for {outfit}')
