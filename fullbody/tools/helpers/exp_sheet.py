import glob, os, sys
from PIL import Image, ImageDraw
root, out = sys.argv[1], sys.argv[2]
dirs = sorted(glob.glob(os.path.join(root, '表情', '*')))
W = Image.new('RGB', (250 * 4, 195 * 3), 'white')
dr = ImageDraw.Draw(W)
for i, d in enumerate(dirs):
    im = Image.open(os.path.join(d, '五官合并.png')).convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 240, 225, 255)); bg.alpha_composite(im)
    t = bg.crop((380, 330, 880, 680)).resize((250, 175))
    x, y = (i % 4) * 250, (i // 4) * 195
    W.paste(t.convert('RGB'), (x, y)); dr.text((x + 4, y + 178), os.path.basename(d).split('-')[0], fill='black')
W.save(out)
