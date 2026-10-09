import sys
from PIL import Image, ImageDraw
def crop(p, box, k=3):
    im = Image.open(p).convert('RGB'); w, h = im.size
    c = im.crop((int(w*box[0]), int(h*box[1]), int(w*box[2]), int(h*box[3])))
    return c.resize((c.width*k, c.height*k), Image.NEAREST)
def pair(out, before, after, box, k=3):
    a, b = crop(before, box, k), crop(after, box, k)
    W = a.width + b.width + 10; H = max(a.height, b.height) + 22
    s = Image.new('RGB', (W, H), (30, 30, 30)); d = ImageDraw.Draw(s)
    s.paste(a, (0, 22)); s.paste(b, (a.width + 10, 22))
    d.text((4, 4), 'before', fill='white'); d.text((a.width + 14, 4), 'after', fill='white')
    s.save(out); print(out, s.size)
head = (.3, .36, .7, .6)
pair('ba/D14_angX_m.png', 'acc3/p_angX_m.png', 'acc5/p_angX_m.png', head)
pair('ba/D14_angX_p.png', 'acc3/p_angX_p.png', 'acc5/p_angX_p.png', head)
pair('ba/D14_base.png', 'acc3/p00_base.png', 'acc5/p00_base.png', head)
pair('ba/D13_mouth.png', 'acc3/p00_base.png', 'acc5/p00_base.png', (.4, .6, .6, .72), 4)
pair('ba/D2_closed.png', 'acc3/p_eyes_closed.png', 'acc5/p_eyes_closed.png', head)
