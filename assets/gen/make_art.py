#!/usr/bin/env python3
"""数方 Suguru 的美术资产生成器（仓内、可复现、零第三方依赖之外的选择）。

为什么在仓里自己画，而不跑组合级 make_icons.py：
  * 那张脚本把母图写到 lead/007_美术资产，属于**跨仓写盘**，本单的硬约束是改动只准落在本仓；
  * 它的 MOTIF 表里没有 suguru 这一类（数方的母题既不是 tiles 也不是 digits 单族，而是
    "带粗边界的不规则区域 + 区域格数即数字上限"），硬套只会画出另一个游戏的图标。

母题不是编的：盘面直接取引擎出货的一张 5×5 trainee 题面（seed `sg|motif|1`），
gid/glen/givens/solution 四个数组是 `makePuzzle` 的实测输出，且
`verify(board, solution).ok === true`。所以图标上那块盘**本身就是一局合法的数方**：
每个区域恰好装着 1..区域格数，共边或共角的格子数字互不相同。
颜色不新抄一份：从 js/theme.js 里读 Palette / Regions / Cell，图标和页面不可能长成一个样两副面孔。

产出（全部是真 PNG，跑一遍就落盘，尺寸见 SIZES）：
  icons/icon-1024.png  母图（1024，圆角方牌）
  icons/icon-512.png / icon-192.png / icon-maskable-512.png
  icons/apple-touch-icon.png（180，iOS 不认透明，满幅铺底）
  icons/favicon-48.png / favicon-32.png / favicon-16.png
  icons/og-image.png（1200×630 社交卡）
  art/tex-board.png（256 无缝噪声纹理，画布盘面底）
  art/spark.png（64 径向粒子，收工时的火花）

用法：python3 assets/gen/make_art.py [--out .]
"""
import argparse
import hashlib
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

GEN_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(GEN_DIR))

# ---- 母题：引擎出货的一张 5×5（见文件头） ----------------------------------------------
BOARD_W = 5
BOARD_H = 5
GID = [3, 3, 3, 0, 2, 3, 3, 3, 0, 2, 1, 0, 0, 0, 2, 1, 0, 0, 2, 2, 1, 1, 1, 2, 2]
GLEN = [7, 5, 7, 6]
GIVENS = [1, 0, 2, 0, 0, 5, 0, 0, 7, 0, 2, 0, 1, 0, 2, 3, 0, 0, 3, 0, 0, 1, 0, 4, 1]
SOLUTION = [1, 4, 2, 3, 5, 5, 3, 6, 7, 6, 2, 4, 1, 5, 2, 3, 6, 2, 3, 7, 4, 1, 5, 4, 1]


def read_theme():
    """js/theme.js 是颜色与几何的唯一来源，这里只读不猜。"""
    src = open(os.path.join(REPO, 'js', 'theme.js'), encoding='utf-8').read()

    def block(name):
        m = re.search(r'export const %s = \{(.*?)\n\}' % name, src, re.S)
        return m.group(1)

    pal = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", block('Palette')))
    reg = re.search(r"export const Regions = \[(.*?)\]", src)
    regions = re.findall(r"'([^']+)'", reg.group(1))
    cell = {k: float(v) for k, v in re.findall(r"(\w+)\s*:\s*([0-9.]+)", re.search(r'export const Cell = \{(.*?)\}', src, re.S).group(1))}
    return pal, regions, cell


def rgb(h, alpha=None):
    h = h.lstrip('#')
    v = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    return v + (alpha,) if alpha is not None else v


# ---- 区域取色：与 js/render/board.js 的 regionColors 同一条贪心（相邻区域不同色） --------
def region_colors(gid, w, h, n_colors):
    n = max(gid) + 1
    cells = [[] for _ in range(n)]
    for t, g in enumerate(gid):
        cells[g].append(t)
    order = sorted(range(n), key=lambda g: (-len(cells[g]), g))

    def near(g):
        s = set()
        for t in cells[g]:
            r, c = divmod(t, w)
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if not dr and not dc:
                        continue
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < h and 0 <= cc < w:
                        o = gid[rr * w + cc]
                        if o != g:
                            s.add(o)
        return s

    color = [-1] * n
    for g in order:
        used = {color[o] for o in near(g) if color[o] >= 0}
        k = 0
        while k < n_colors and k in used:
            k += 1
        color[g] = k % n_colors
    return color, cells


# ---- 绘制 ---------------------------------------------------------------------------
def v_gradient(size, top, bottom, stop=0.62):
    """页面那块 180deg 渐变（bg-top → bg-bottom → surface）的位图版。"""
    w, h = size
    img = Image.new('RGB', (w, h))
    dr = ImageDraw.Draw(img)
    a, b = rgb(top), rgb(bottom)
    for y in range(h):
        k = min(1.0, y / max(1, (h - 1)))
        t = k / stop if k <= stop else 1.0
        f = min(1.0, t)
        dr.line([(0, y), (w, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(3)))
    return img


def noise_hash(x, y, size, salt):
    """对 (x mod size, y mod size) 取哈希 ⇒ 天然左右上下无缝可拼。"""
    d = hashlib.md5(b'%d,%d,%s' % (x % size, y % size, salt)).digest()
    return d[0] / 255.0


def add_noise(img, size, salt, amp):
    """把无缝噪声以加法拍进 img（原地，alpha 原样保留）。"""
    px = img.load()
    has_a = img.mode == 'RGBA'
    w, h = img.size
    for y in range(h):
        for x in range(w):
            n = (noise_hash(x, y, size, salt) - 0.5) * 2 * amp
            p = px[x, y]
            out = tuple(max(0, min(255, int(v + n))) for v in p[:3])
            px[x, y] = out + (p[3],) if has_a else out
    return img


def pick_font(paths, size):
    for p, idx in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=idx)
            except OSError:
                continue
    return ImageFont.load_default()


DIGIT_FONTS = [
    ('/System/Library/Fonts/HelveticaNeue.ttc', 1),   # Bold（直立；index 2 是 Italic，会把数字写斜）
    ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 0),
    ('/System/Library/Fonts/Menlo.ttc', 1),
]
CJK_FONTS = [
    ('/System/Library/Fonts/PingFang.ttc', 0),
    ('/System/Library/Fonts/Hiragino Sans GB.ttc', 0),
    ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 0),
]


def draw_board(dr, ox, oy, cell, pal, regions, show_digits, digit_font, border_ratio, tint_alpha=255):
    """一块真的数方盘：区域底色 → 域内细线 → 区域粗边界 → 数字。和 canvas 层同一套次序。"""
    gid = GID
    cols, cells = region_colors(gid, BOARD_W, BOARD_H, len(regions))
    surf = rgb(pal['surface'])
    line = rgb(pal['line'])
    heavy = rgb(pal['lineHeavy'])
    board_w, board_h = cell * BOARD_W, cell * BOARD_H

    dr.rectangle([ox, oy, ox + board_w - 1, oy + board_h - 1], fill=surf + (255,))
    for t, g in enumerate(gid):
        r, c = divmod(t, BOARD_W)
        x, y = ox + c * cell, oy + r * cell
        dr.rectangle([x, y, x + cell - 1, y + cell - 1], fill=rgb(regions[cols[g]]) + (tint_alpha,))

    # 域内细线：同区域两格之间那条，告诉玩家"这是一块里的两格"
    for t, g in enumerate(gid):
        r, c = divmod(t, BOARD_W)
        x, y = ox + c * cell, oy + r * cell
        if c + 1 < BOARD_W and gid[t + 1] == g:
            dr.line([(x + cell, y), (x + cell, y + cell)], fill=line + (255,), width=1)
        if r + 1 < BOARD_H and gid[t + BOARD_W] == g:
            dr.line([(x, y + cell), (x + cell, y + cell)], fill=line + (255,), width=1)

    # 区域边界：换区域或撞到盘边就是粗线。线宽按 cell 走，16px 的 favicon 上也还有可见的分隔。
    lw = max(1, round(cell * border_ratio))
    heavy_px = heavy + (255,)
    for t, g in enumerate(gid):
        r, c = divmod(t, BOARD_W)
        x, y = ox + c * cell, oy + r * cell
        sep = lambda o: o is None or gid[o] != g
        right = t + 1 if c + 1 < BOARD_W else None
        left = t - 1 if c - 1 >= 0 else None
        down = t + BOARD_W if r + 1 < BOARD_H else None
        up = t - BOARD_W if r - 1 >= 0 else None
        if sep(right):
            dr.line([(x + cell - 1, y - (lw // 2)), (x + cell - 1, y + cell + (lw // 2))], fill=heavy_px, width=lw)
        if sep(left):
            dr.line([(x, y - (lw // 2)), (x, y + cell + (lw // 2))], fill=heavy_px, width=lw)
        if sep(down):
            dr.line([(x - (lw // 2), y + cell - 1), (x + cell + (lw // 2), y + cell - 1)], fill=heavy_px, width=lw)
        if sep(up):
            dr.line([(x - (lw // 2), y), (x + cell + (lw // 2), y)], fill=heavy_px, width=lw)

    if show_digits:
        given_c = rgb(pal['given']) + (255,)
        player_c = rgb(pal['player']) + (255,)
        for t, v in enumerate(SOLUTION):
            r, c = divmod(t, BOARD_W)
            x, y = ox + c * cell, oy + r * cell
            col = given_c if GIVENS[t] else player_c
            dr.text((x + cell / 2, y + cell / 2), str(v), font=digit_font, fill=col, anchor='mm')
    return board_w, board_h


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def make_icon(px, pal, regions, cell_consts, full_bleed=False, digits=True):
    """一枚图标：圆角方牌 + 那块盘。full_bleed=True 给 maskable / apple-touch（不切透明）。"""
    bg_top, bg_bottom = rgb(pal['bgTop']), rgb(pal['bgBottom'])
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    card = v_gradient((px, px), pal['bgTop'], pal['bgBottom'])
    card = card.convert('RGBA')
    add_noise(card, 64, b'surface', 4)

    # 盘占的边长：maskable 要把内容压进 80% 安全区（Android 会裁成圆/方）
    span = int(px * (0.72 if full_bleed else 0.68))
    cell = max(3, span // BOARD_W)
    board_px = cell * BOARD_W
    ox = (px - board_px) // 2
    oy = (px - board_px) // 2

    digit_scale = float(cell_consts['digitScale'])
    dfont = pick_font(DIGIT_FONTS, max(7, int(round(cell * digit_scale))))
    show = digits and cell >= 13
    dr = ImageDraw.Draw(card, 'RGBA')
    # 牌底：整幅圆角（非满幅时切出圆角，跟 app 的 Radius.card 同比例）
    draw_board(dr, ox, oy, cell, pal, regions, show, dfont, cell_consts['border'] * 1.6)
    if not full_bleed:
        card.putalpha(rounded_mask((px, px), px * 0.22))
    img = Image.alpha_composite(img, card)
    return img


def make_og(pal, regions, cell_consts):
    W, H = 1200, 630
    img = v_gradient((W, H), pal['bgTop'], pal['bgBottom']).convert('RGBA')
    add_noise(img, 64, b'surface', 4)
    dr = ImageDraw.Draw(img, 'RGBA')

    # 右侧：盘面当主角（大 cell，数字全程可读）
    cell = 92
    board_px = cell * BOARD_W
    ox, oy = W - board_px - 84, (H - board_px) // 2
    dfont = pick_font(DIGIT_FONTS, int(cell * float(cell_consts['digitScale'])))
    draw_board(dr, ox, oy, cell, pal, regions, True, dfont, cell_consts['border'] * 1.6)

    # 左侧：商品名 + 一句话卖点（规则原文的说法，不是广告词）
    tx, ty = 84, 150
    dr.text((tx, ty), '数方', font=pick_font(CJK_FONTS, 132), fill=rgb(pal['ink']) + (255,))
    dr.text((tx, ty + 168), 'Suguru · 区域推理', font=pick_font(CJK_FONTS, 48), fill=rgb(pal['accent']) + (255,))
    note = '每个区域装下 1 到它的格数\n共边或共角的格子数字不能相同\n每局唯一解 · 每局都能用逻辑推到底'
    dr.text((tx, ty + 258), note, font=pick_font(CJK_FONTS, 30), fill=rgb(pal['ink']) + (168,))
    return img.convert('RGB')


def make_texture(px, pal):
    """盘底纹理：亮度贴着 surface，幅度小到一个不细看就注意不到的纸感。无缝可拼。"""
    base = rgb(pal['surface'])
    img = Image.new('RGBA', (px, px), base + (255,))
    add_noise(img, px, b'board-tex', 6)
    return img


def make_spark(px, pal):
    """径向火花：中心实、边缘透明，运行时按 tint 上色，用于收工粒子。"""
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    c = rgb(pal['accentEdge'])
    r0 = px / 2.0
    for i in range(px):
        for j in range(px):
            d = ((i - r0 + 0.5) ** 2 + (j - r0 + 0.5) ** 2) ** 0.5 / r0
            a = max(0.0, 1.0 - d)
            a = a ** 2.4
            img.putpixel((i, j), c + (int(round(a * 255)),))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=REPO)
    a = ap.parse_args()
    pal, regions, cell_consts = read_theme()

    targets = {
        'icons/icon-1024.png': make_icon(1024, pal, regions, cell_consts),
        'icons/icon-512.png': make_icon(512, pal, regions, cell_consts),
        'icons/icon-192.png': make_icon(192, pal, regions, cell_consts),
        'icons/icon-maskable-512.png': make_icon(512, pal, regions, cell_consts, full_bleed=True),
        'icons/apple-touch-icon.png': make_icon(180, pal, regions, cell_consts, full_bleed=True),
        'icons/favicon-48.png': make_icon(48, pal, regions, cell_consts, full_bleed=True, digits=False),
        'icons/favicon-32.png': make_icon(32, pal, regions, cell_consts, full_bleed=True, digits=False),
        'icons/favicon-16.png': make_icon(16, pal, regions, cell_consts, full_bleed=True, digits=False),
        'icons/og-image.png': make_og(pal, regions, cell_consts),
        'art/tex-board.png': make_texture(256, pal),
        'art/spark.png': make_spark(64, pal),
    }
    for rel, im in targets.items():
        path = os.path.join(a.out, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im.save(path)
        print('%-32s %5dx%-5d %s' % (rel, im.size[0], im.size[1], os.path.getsize(path)))
    print('OK %d 张' % len(targets))


if __name__ == '__main__':
    sys.exit(main())
