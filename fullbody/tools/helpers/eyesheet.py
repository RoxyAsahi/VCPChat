import sys
from PIL import Image
d, vals = sys.argv[1], sys.argv[2:]
ims = []
for v in vals:
    im = Image.open(f'{d}/eye{v}.png'); w, h = im.size
    bg = Image.new('RGBA', im.size, (40, 42, 50, 255)); bg.alpha_composite(im)
    c = bg.crop((int(w * .30), int(h * .50), int(w * .72), int(h * .61)))
    ims.append(c.resize((c.width * 2, c.height * 2), Image.LANCZOS))
W, H = ims[0].size
sh = Image.new('RGBA', (W, H * len(ims)))
for k, i in enumerate(ims): sh.paste(i, (0, k * H))
sh.save(f'{d}/__zoom_eyes.png'); print(sh.size)
