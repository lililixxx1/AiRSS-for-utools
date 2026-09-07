# -*- coding: utf-8 -*-
"""make-logo.py — 生成 AiRSS logo.png（256×256）

设计（参考图右上角插件图标）：橙 #F97316 圆角方块 + 白色 "Ai" + 右下角 rss 波纹圆点。
用法：python scripts/make-logo.py  （输出 logo.png 到项目根）
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 256
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ORANGE = (249, 115, 22, 255)        # #F97316
ORANGE_DEEP = (234, 88, 12, 255)    # #EA580C
WHITE = (255, 255, 255, 255)
INK = (67, 20, 7, 255)              # #431407（橙底上的深字）

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方块底
d.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=56, fill=ORANGE)

# "Ai" 主字
font = None
for name, size in [("segoeuib.ttf", 118), ("arialbd.ttf", 118), ("seguisb.ttf", 112)]:
    try:
        font = ImageFont.truetype(name, size)
        break
    except OSError:
        continue
if font is None:
    font = ImageFont.load_default()

text = "Ai"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx = (SIZE - tw) // 2 - bbox[0]
ty = (SIZE - th) // 2 - bbox[1] - 14
d.text((tx, ty), text, font=font, fill=INK)

# 右下角 rss 波纹：两段圆弧 + 一个实心点（白色）
arc_cx, arc_cy = SIZE - 52, SIZE - 52
d.arc([arc_cx - 34, arc_cy - 34, arc_cx + 34, arc_cy + 34], start=180, end=270, fill=WHITE, width=11)
d.arc([arc_cx - 58, arc_cy - 58, arc_cx + 58, arc_cy + 58], start=190, end=262, fill=ORANGE_DEEP, width=9)
d.ellipse([arc_cx - 9, arc_cy - 9, arc_cx + 9, arc_cy + 9], fill=WHITE)

out = os.path.join(ROOT, "logo.png")
img.save(out)
print("written:", out)
