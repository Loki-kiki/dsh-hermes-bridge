#!/usr/bin/env python3
"""Rebuild the README artwork for dsh-hermes-bridge.

Everything the README shows in `docs/images/` is generated here so the vector and
raster versions of the icon cannot drift apart:

    python docs/images/build-diagrams.py

Outputs (overwritten in place):
    icon.svg        256x256 project mark, no text -> renders everywhere
    icon.png        the same mark, rasterised (npm / plugin pages that want a PNG)
    bridge-flow.png 1000x360 "what gets bridged where" diagram

Fonts: Microsoft YaHei (CJK + latin) and Segoe UI Bold, both shipped with Windows.
"""

from __future__ import annotations

import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent

BG = (11, 18, 32)          # #0B1220
PANEL = (17, 28, 46)       # #111C2E
PANEL_EDGE = (30, 44, 69)  # #1E2C45
LANE = (20, 33, 58)        # #14213A
LANE_EDGE = (36, 54, 90)   # #24365A
CYAN = (34, 211, 238)      # #22D3EE
VIOLET = (168, 85, 247)    # #A855F7
TITLE = (230, 237, 247)    # #E6EDF7
MUTED = (143, 163, 191)    # #8FA3BF
BODY = (195, 208, 224)     # #C3D0E0
LANE_TEXT = (216, 228, 245)
LEFT_ACCENT = (125, 211, 252)   # #7DD3FC
RIGHT_ACCENT = (196, 181, 253)  # #C4B5FD

CJK = "C:/Windows/Fonts/msyh.ttc"
CJK_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
LATIN = "C:/Windows/Fonts/segoeuib.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


# --------------------------------------------------------------------------- icon

ICON = 256
NODES = ((40, 192), (128, 126), (216, 192))   # left pier, apex, right pier


def arch_circle() -> tuple[float, float, float]:
    """Circle through all three NODES, so the span always meets the piers exactly."""
    (x0, y0), (x1, y1), (x2, y2) = NODES
    d = 2 * (x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1))
    ux = ((x0**2 + y0**2) * (y1 - y2) + (x1**2 + y1**2) * (y2 - y0) + (x2**2 + y2**2) * (y0 - y1)) / d
    uy = ((x0**2 + y0**2) * (x2 - x1) + (x1**2 + y1**2) * (x0 - x2) + (x2**2 + y2**2) * (x1 - x0)) / d
    r = math.hypot(x0 - ux, y0 - uy)
    return ux, uy, r


def arc_angles() -> tuple[float, float]:
    """Start/end angle (degrees, y-down) of the arch between the two outer piers."""
    ux, uy, _ = arch_circle()
    (x0, y0), _, (x2, y2) = NODES
    return (math.degrees(math.atan2(y0 - uy, x0 - ux)) % 360,
            math.degrees(math.atan2(y2 - uy, x2 - ux)) % 360)


def gradient_layer() -> Image.Image:
    """Diagonal cyan -> violet fill: cyan at the top-left, violet at the bottom-right."""
    grad = Image.new("RGBA", (ICON, ICON))
    px = grad.load()
    for y in range(ICON):
        for x in range(ICON):
            t = (x + y) / (2 * (ICON - 1))
            px[x, y] = lerp(CYAN, VIOLET, t) + (255,)
    return grad


def plate_mask(inset: int = 14, radius: int = 48) -> Image.Image:
    m = Image.new("L", (ICON, ICON), 0)
    ImageDraw.Draw(m).rounded_rectangle((inset, inset, ICON - 1 - inset, ICON - 1 - inset), radius=radius, fill=255)
    return m


def shape_mask() -> tuple[Image.Image, Image.Image]:
    """Masks for the span stroke and for the three nodes."""
    ux, uy, r = arch_circle()
    start, end = arc_angles()
    stroke = Image.new("L", (ICON, ICON), 0)
    ImageDraw.Draw(stroke).arc((ux - r, uy - r, ux + r, uy + r), start=start, end=end, fill=255, width=15)
    nodes = Image.new("L", (ICON, ICON), 0)
    nd = ImageDraw.Draw(nodes)
    for i, (cx, cy) in enumerate(NODES):
        rr = 16 if i == 1 else 14
        nd.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=255)
    return stroke, nodes


def draw_icon_raster() -> Image.Image:
    grad = gradient_layer()
    plate = plate_mask()
    stroke, nodes = shape_mask()

    # dark plate on top of a gradient rim
    img = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    rim = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    rim.paste(grad, (0, 0), plate_mask(4, 58))
    img.alpha_composite(rim)
    body = Image.new("RGBA", (ICON, ICON), BG + (255,))
    img.paste(body, (0, 0), plate_mask(14, 48))

    # soft glow under the span, then the span itself in gradient
    glow_mask = Image.new("L", (ICON, ICON), 0)
    glow_mask.paste(stroke, (0, 0))
    glow_mask.paste(nodes, (0, 0))
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(11)).point(lambda v: int(v * 0.55))
    glow = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    glow.paste(grad, (0, 0), glow_mask)
    img.alpha_composite(Image.composite(glow, Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0)), plate))

    paint = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    paint.paste(grad, (0, 0), stroke)
    paint.paste(grad, (0, 0), nodes)
    img.alpha_composite(paint)

    # dark ring inside each node so they read as sockets on the span, not blobs
    d = ImageDraw.Draw(img)
    for i, (cx, cy) in enumerate(NODES):
        r = 16 if i == 1 else 14
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=BG + (255,), width=3)
        d.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=BG + (255,))
    return img


def write_icon_svg() -> str:
    """Same mark as the raster, in vector form, so it stays crisp at any size."""
    ux, uy, r = arch_circle()
    start, end = arc_angles()
    (x0, y0), _, (x2, y2) = NODES

    def pt(deg: float) -> tuple[float, float]:
        rad = math.radians(deg)
        return ux + r * math.cos(rad), uy + r * math.sin(rad)

    a, b = pt(start), pt(end)
    large = 1 if (end - start) % 360 > 180 else 0

    def node_svg(*, ring: bool) -> str:
        out = []
        for i, (x, y) in enumerate(NODES):
            rr = 16 if i == 1 else 14
            stroke_attr = f' stroke="#0B1220" stroke-width="{3 if ring else 5}"' if ring else ""
            out.append(f'<circle cx="{x}" cy="{y}" r="{rr}" fill="url(#ramp)"{stroke_attr}/>')
            if ring:
                out.append(f'<circle cx="{x}" cy="{y}" r="5" fill="#0B1220"/>')
        return "".join(out)

    span = (f'<path d="M {a[0]:.1f} {a[1]:.1f} A {r:.2f} {r:.2f} 0 {large} 1 {b[0]:.1f} {b[1]:.1f}" '
            f'fill="none" stroke="url(#ramp)" stroke-width="15" stroke-linecap="round"/>')
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="dsh-hermes-bridge">
  <defs>
    <linearGradient id="ramp" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#A855F7"/>
    </linearGradient>
    <clipPath id="plate"><rect x="14" y="14" width="228" height="228" rx="48"/></clipPath>
    <filter id="glow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
  </defs>
  <rect x="4" y="4" width="248" height="248" rx="58" fill="url(#ramp)"/>
  <rect x="14" y="14" width="228" height="228" rx="48" fill="#0B1220"/>
  <g clip-path="url(#plate)">
    <g filter="url(#glow)" opacity="0.55">{span}{node_svg(ring=False)}</g>
    {span}
    {node_svg(ring=True)}
  </g>
</svg>
"""


# ------------------------------------------------------------------ plugin icon

# DSH renders a bundle icon through PackageArtwork: 36px inside a card's 48px frame
# and 30px inside a row's 40px frame, object-fit: contain. The official bundles all
# ship a transparent 36-viewBox glyph (no plate), because a tile with its own dark
# background turns into an unreadable blob at 30px. So this mark shares the geometry
# of docs/images/icon.svg but drops the plate and thickens the strokes.
PLUGIN_VIEWBOX = 36
# Geometry chosen so nothing can clip at 30px: the arc's lowest point is uy + r, whose
# stroke reaches uy + r + stroke/2 = 28.35, and a pier's outer ring reaches
# 24.6 + 3.9 + 0.45 = 28.95 — both inside 36 with margin. Piers at 26 clipped the arc.
PLUGIN_NODES = ((6.0, 24.6), (18.0, 10.8), (30.0, 24.6))


def plugin_arch() -> tuple[float, float, float]:
    """Circle through the three plugin-icon nodes, same construction as the tile."""
    (x0, y0), (x1, y1), (x2, y2) = PLUGIN_NODES
    d = 2 * (x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1))
    ux = ((x0**2 + y0**2) * (y1 - y2) + (x1**2 + y1**2) * (y2 - y0) + (x2**2 + y2**2) * (y0 - y1)) / d
    uy = ((x0**2 + y0**2) * (x2 - x1) + (x1**2 + y1**2) * (x0 - x2) + (x2**2 + y2**2) * (x1 - x0)) / d
    return ux, uy, math.hypot(x0 - ux, y0 - uy)


def write_plugin_icon_svg() -> str:
    ux, uy, r = plugin_arch()
    (x0, y0), (x1, y1), (x2, y2) = PLUGIN_NODES
    start = math.degrees(math.atan2(y0 - uy, x0 - ux)) % 360
    end = math.degrees(math.atan2(y2 - uy, x2 - ux)) % 360

    def pt(deg: float) -> tuple[float, float]:
        rad = math.radians(deg)
        return ux + r * math.cos(rad), uy + r * math.sin(rad)

    a, b = pt(start), pt(end)
    large = 1 if (end - start) % 360 > 180 else 0
    nodes = "".join(
        f'<circle cx="{x}" cy="{y}" r="{4.4 if i == 1 else 3.9}" fill="url(#ramp)" '
        f'stroke="#0B1220" stroke-width="0.9"/>'
        f'<circle cx="{x}" cy="{y}" r="2.05" fill="#0B1220"/>'
        for i, (x, y) in enumerate(PLUGIN_NODES)
    )
    span = (f'<path d="M {a[0]:.2f} {a[1]:.2f} A {r:.2f} {r:.2f} 0 {large} 1 {b[0]:.2f} {b[1]:.2f}" '
            f'fill="none" stroke="url(#ramp)" stroke-width="3.1" stroke-linecap="round"/>')
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{PLUGIN_VIEWBOX}" height="{PLUGIN_VIEWBOX}" viewBox="0 0 {PLUGIN_VIEWBOX} {PLUGIN_VIEWBOX}" role="img" aria-label="Hermes Bridge">
  <defs>
    <linearGradient id="ramp" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#A855F7"/>
    </linearGradient>
  </defs>
  {span}
  {nodes}
</svg>
"""


# ---------------------------------------------------------------------- flow map

FLOW_W, FLOW_H = 1160, 380
PAD = 24

# Every label drawn on the flow diagram records (label, fits?, detail).
# self_check() asserts on these, so a layout regression fails the build instead of
# quietly shipping text that runs past its box — which is exactly what happened when
# these coordinates were hardcoded.
FLOW_FIT: list[tuple[str, bool, str]] = []
# Fonts actually used for the six lane descriptions, so self_check can prove no lane
# had to shrink to fit (a shrunk lane looks inconsistent next to its neighbours).
LANE_DESC_SIZES: list[ImageFont.FreeTypeFont] = []

LANES: list[tuple[str, str]] = [
    ("persona", "SOUL.md  →  系统提示词段"),
    ("memory", "MEMORY.md + USER.md  →  常驻记忆段"),
    ("memory-write", "memory 工具：list / add / patch / remove"),
    ("skills", "技能库  →  ctx.skills provider"),
    ("viking", "OpenViking  →  4 个 viking_* 工具"),
    ("hermes-data", "cron + 会话历史  →  3 个只读工具"),
]

LEFT_ITEMS = ["SOUL.md", "MEMORY.md · USER.md", "skills/", "config.yaml（MCP）", "OpenViking", "state.db · cron"]
RIGHT_ITEMS = ["系统提示词段", "常驻记忆段", "skill 工具", "MCP 行", "viking_* ×4", "hermes_* ×3"]


def fit_font(draw: ImageDraw.ImageDraw, path: str, size: int, text: str, max_width: float) -> ImageFont.FreeTypeFont:
    """Largest font at or below `size` whose rendering of `text` fits `max_width`."""
    f = font(path, size)
    if draw.textlength(text, font=f) <= max_width:
        return f
    for s in range(size - 1, 9, -1):
        f = font(path, s)
        if draw.textlength(text, font=f) <= max_width:
            return f
    return font(path, 10)


def rounded(d: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width: int = 1) -> None:
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def arrow(d: ImageDraw.ImageDraw, x0: int, x1: int, y: int, color) -> None:
    d.line((x0, y, x1 - 8, y), fill=color, width=2)
    d.polygon(((x1, y), (x1 - 11, y - 6), (x1 - 11, y + 6)), fill=color)


def draw_flow() -> Image.Image:
    FLOW_FIT.clear()
    LANE_DESC_SIZES.clear()
    img = Image.new("RGB", (FLOW_W, FLOW_H), BG)
    d = ImageDraw.Draw(img)

    f_head = font(CJK_BOLD, 21)
    f_lane_key = font(CJK_BOLD, 17)
    f_foot = font(CJK, 15)

    # header — the subtitle is placed after the measured title, never at a guess
    title = "dsh-hermes-bridge"
    f_title = font(CJK_BOLD, 30)
    d.text((PAD, 20), title, font=f_title, fill=TITLE)
    title_right = PAD + d.textlength(title, font=f_title)

    subtitle = "把 Hermes 的资源按 DSH 自己的接口装进去"
    sub_left = title_right + 44
    sub_w = d.textlength(subtitle, font=fit_font(d, CJK, 18, subtitle, FLOW_W - PAD - sub_left))
    d.text((sub_left, 30), subtitle, font=fit_font(d, CJK, 18, subtitle, FLOW_W - PAD - sub_left), fill=MUTED)
    FLOW_FIT.append(("header: subtitle clears the title", sub_left >= title_right + 8, f"sub_left={sub_left:.0f} title_right={title_right:.0f}"))
    FLOW_FIT.append(("header: subtitle inside canvas", sub_left + sub_w <= FLOW_W - PAD, f"ends={sub_left + sub_w:.0f} limit={FLOW_W - PAD}"))

    d.line((PAD, 72, FLOW_W - PAD, 72), fill=PANEL_EDGE, width=1)

    top, bottom = 94, 330
    panel_w = 264
    lx0, rx1 = PAD, FLOW_W - PAD
    lp = (lx0, top, lx0 + panel_w, bottom)
    rp = (rx1 - panel_w, top, rx1, bottom)
    rounded(d, lp, 18, PANEL, PANEL_EDGE)
    rounded(d, rp, 18, PANEL, PANEL_EDGE)
    d.text((lp[0] + 22, top + 18), "Hermes Agent", font=f_head, fill=LEFT_ACCENT)
    d.text((rp[0] + 22, top + 18), "DeepSeek Harness", font=f_head, fill=RIGHT_ACCENT)

    for panel, items, accent, tag in (
        (lp, LEFT_ITEMS, LEFT_ACCENT, "left panel"),
        (rp, RIGHT_ITEMS, RIGHT_ACCENT, "right panel"),
    ):
        text_x = panel[0] + 26
        limit = panel[2] - 14
        for i, item in enumerate(items):
            y = top + 58 + i * 26
            f = fit_font(d, CJK, 17, item, limit - text_x)
            d.ellipse((panel[0] + 14, y + 6, panel[0] + 20, y + 12), fill=accent)
            d.text((text_x, y), item, font=f, fill=BODY)
            right = text_x + d.textlength(item, font=f)
            FLOW_FIT.append((f"{tag}: {item}", right <= limit, f"ends={right:.0f} limit={limit:.0f}"))

    lane_x0, lane_x1 = lp[2] + 30, rp[0] - 30
    lane_h, gap = 34, 4
    lanes_top = top + 12
    for i, (key, text) in enumerate(LANES):
        y = lanes_top + i * (lane_h + gap)
        rounded(d, (lane_x0, y, lane_x1, y + lane_h), 10, LANE, LANE_EDGE)
        accent = lerp(CYAN, VIOLET, i / (len(LANES) - 1))
        d.rounded_rectangle((lane_x0, y, lane_x0 + 4, y + lane_h), radius=2, fill=accent)
        key_x = lane_x0 + 16
        d.text((key_x, y + 8), key, font=f_lane_key, fill=accent)
        desc_x = key_x + d.textlength(key, font=f_lane_key) + 12
        limit = lane_x1 - 16
        f_desc = fit_font(d, CJK, 17, text, limit - desc_x)
        LANE_DESC_SIZES.append(f_desc)
        d.text((desc_x, y + 8), text, font=f_desc, fill=LANE_TEXT)
        right = desc_x + d.textlength(text, font=f_desc)
        FLOW_FIT.append((f"lane: {key}", right <= limit, f"ends={right:.0f} limit={limit:.0f}"))
        arrow(d, lp[2] + 4, lane_x0 - 2, y + lane_h // 2, PANEL_EDGE)
        arrow(d, lane_x1 + 2, rp[0] - 4, y + lane_h // 2, PANEL_EDGE)

    footer = "每一行都能在插件页单独启停；另有两行不挂功能：host 承载设置界面，settings 提供页面数据。"
    f_foot2 = fit_font(d, CJK, 15, footer, FLOW_W - 2 * PAD)
    d.text((PAD, bottom + 22), footer, font=f_foot2, fill=MUTED)
    foot_right = PAD + d.textlength(footer, font=f_foot2)
    FLOW_FIT.append(("footer", foot_right <= FLOW_W - PAD, f"ends={foot_right:.0f} limit={FLOW_W - PAD}"))
    return img


def self_check() -> int:
    """Assert the generated marks are actually what the README claims. Never ship blind."""
    icon = Image.open(HERE / "icon.png").convert("RGBA")
    flow = Image.open(HERE / "bridge-flow.png")
    fails: list[str] = []

    def check(label: str, ok: bool, extra: object = "") -> None:
        print(("PASS  " if ok else "FAIL  ") + label + (f"  {extra}" if extra else ""))
        if not ok:
            fails.append(label)

    def px(x: int, y: int) -> tuple[int, ...]:
        return icon.getpixel((x, y))

    check("icon is 256x256 RGBA", icon.size == (256, 256), icon.size)
    check("corners are transparent", px(2, 2)[3] == 0 and px(253, 253)[3] == 0, px(2, 2))
    check("plate interior stays dark", px(128, 52)[:3] == BG, px(128, 52))

    # gradient direction, measured on the painted rim: cyan (green-heavy) on the left,
    # violet (green-poor) on the right. Violet's blue channel is high too, so green is
    # the only reliable discriminator between the two ends.
    left_rim, right_rim = px(9, 128), px(247, 128)
    check("gradient runs cyan(left) -> violet(right)",
          left_rim[1] > 150 and right_rim[1] < 150, f"left={left_rim} right={right_rim}")

    def on_span(x: int, drop: int = 3) -> tuple[tuple[int, ...], int]:
        """Sample on the arch, a few px below its top edge so we hit the 15px stroke."""
        ux_, uy_, r_ = arch_circle()
        y = round(uy_ - math.sqrt(r_**2 - (x - ux_) ** 2)) + drop
        return px(x, y), y

    # the span must be painted exactly where the arch circle says it is
    for label, x, drop in (("left half", 84, 3), ("apex", 128, 8), ("right half", 172, 3)):
        paint, y = on_span(x, drop)
        check(f"span is painted on the arch at {label}", paint[3] == 255 and sum(paint[:3]) > 200, f"({x},{y})={paint}")

    # and each node keeps its dark hub, so the three sockets read as sockets
    for name, (nx, ny) in (("left pier", NODES[0]), ("apex", NODES[1]), ("right pier", NODES[2])):
        hub = px(nx, ny)
        check(f"{name} keeps a dark hub", hub[:3] == BG, hub)

    check("flow diagram is 1160x380", flow.size == (FLOW_W, FLOW_H), flow.size)
    # the lane panel is the panel colour, not the page background: prove it got drawn
    panel_probe = flow.getpixel((560, 110))
    check("flow lanes panel is painted", panel_probe != BG, panel_probe)
    dark_ink = sum(1 for y in range(90, 320, 4) if flow.getpixel((560, y)) == BG)
    check("flow middle column carries lane text ink", dark_ink > 4, dark_ink)

    # every label must stay inside the box it belongs to (measured while drawing)
    check("flow recorded every label it drew", len(FLOW_FIT) >= 18, f"{len(FLOW_FIT)} labels")
    for label, fits, detail in FLOW_FIT:
        check(f"fits: {label}", fits, detail)

    # the six lane descriptions must all render at the intended size: a shrunk one
    # (i.e. one that needed fit_font to back off) would look visibly inconsistent
    lane_sizes = [f.size for f in LANE_DESC_SIZES]
    check("lane descriptions share one font size", len(set(lane_sizes)) == 1, lane_sizes)
    check("lane descriptions keep the intended size", lane_sizes and lane_sizes[0] == 17, lane_sizes)

    # ---- bundle icon (what DSH's plugin page actually renders) ----------------
    # Contract from the installed DSH skill `cordis-plugin-development`
    # (references/host-plugin.md): SVG/PNG/JPEG/WebP, <= 256 KiB, inside the package.
    # Rendering contract from dsh-client-ui-plugin-manager: 36px in a card, 30px in
    # a row, object-fit: contain — so the glyph must read at 30px and carry no plate.
    bundle_svg = (HERE.parent.parent / "icon.svg")
    check("bundle icon exists at package root", bundle_svg.is_file(), bundle_svg)
    raw = bundle_svg.read_bytes()
    check("bundle icon is under the 256 KiB limit", len(raw) <= 256 * 1024, f"{len(raw)} B")
    text = raw.decode("utf-8")
    try:
        root = ET.fromstring(text)
        parsed = True
        tag = root.tag.split("}")[-1]
    except ET.ParseError as exc:
        parsed, tag = False, str(exc)
    check("bundle icon parses as XML", parsed, tag)
    check("bundle icon is an <svg>", parsed and tag == "svg", tag)
    check("bundle icon declares a 36 viewBox", 'viewBox="0 0 36 36"' in text, "")
    check("bundle icon has no plate rect", "<rect" not in text, "")
    # Every drawn point must sit inside the viewBox, or the glyph clips at 30px.
    nums = [float(v) for v in re.findall(r'\b(?:cx|cy|r)="(-?[\d.]+)"', text)]
    check("bundle icon shapes stay inside the viewBox",
          nums and min(nums) >= 0 and max(nums) <= PLUGIN_VIEWBOX, f"min={min(nums):.2f} max={max(nums):.2f}")
    ux, uy, r = plugin_arch()
    (x0, y0), (x1, y1), (x2, y2) = PLUGIN_NODES
    check("bundle icon span meets both piers",
          all(abs(math.hypot(x - ux, y - uy) - r) < 1e-6 for x, y in ((x0, y0), (x2, y2))), f"r={r:.3f}")

    # Sample the arc actually drawn (start -> end, sweep=1, i.e. increasing angle) and
    # assert its real extent. Checking the whole circle's bottom is wrong: only the
    # stretch over the apex is painted, so the circle dips well below the glyph.
    start = math.degrees(math.atan2(y0 - uy, x0 - ux)) % 360
    end = math.degrees(math.atan2(y2 - uy, x2 - ux)) % 360
    span_deg = (end - start) % 360
    ys = [uy + r * math.sin(math.radians(start + span_deg * i / 240)) for i in range(241)]
    xs = [ux + r * math.cos(math.radians(start + span_deg * i / 240)) for i in range(241)]
    half_stroke = 3.1 / 2
    check("bundle icon arc passes over the apex, not under",
          min(ys) <= y1 + 1e-6, f"arc top={min(ys):.2f} apex={y1}")
    check("bundle icon arc stays inside the viewBox",
          min(xs) - half_stroke >= 0 and max(xs) + half_stroke <= PLUGIN_VIEWBOX
          and min(ys) - half_stroke >= 0 and max(ys) + half_stroke <= PLUGIN_VIEWBOX,
          f"x=[{min(xs) - half_stroke:.2f},{max(xs) + half_stroke:.2f}] y=[{min(ys) - half_stroke:.2f},{max(ys) + half_stroke:.2f}]")
    # nodes must not be clipped either (outer r + its dark ring)
    outer = max(4.4, 3.9) + 0.45
    check("bundle icon nodes stay inside the viewBox",
          all(outer <= nx <= PLUGIN_VIEWBOX - outer and outer <= ny <= PLUGIN_VIEWBOX - outer
              for nx, ny in PLUGIN_NODES),
          f"outer={outer}")
    # a 30px row leaves ~0.83px per viewBox unit; the span must survive that
    check("bundle icon stroke survives a 30px row", 3.1 * 30 / PLUGIN_VIEWBOX >= 2.5,
          f"{3.1 * 30 / PLUGIN_VIEWBOX:.2f}px")
    # a glyph that touches the frame edge gets its stroke cut in half at 30px
    check("bundle icon leaves a safe margin", min(min(xs), min(ys)) - half_stroke >= 1.5
          and max(max(xs), max(ys)) + half_stroke <= PLUGIN_VIEWBOX - 1.5,
          f"left={min(xs) - half_stroke:.2f} bottom={max(ys) + half_stroke:.2f}")

    # ---- rendered pixels (separate step, needs a real rasteriser) -------------
    # `node docs/images/verify-icon.mjs` rasterises icon.svg with sharp and asserts the
    # pixel invariants (symmetry, single fused mark, three hubs, no border ink, apex on
    # the centre line at 30px/36px). It is a separate script because a Python-only run
    # cannot honestly claim anything about rendering.
    verify_js = HERE / "verify-icon.mjs"
    check("verify-icon.mjs exists", verify_js.is_file(), verify_js)

    # ---- locale metadata (title/description the plugin page shows) ------------
    loc = HERE.parent.parent / "locale"
    for lang in ("en", "zh"):
        f = loc / f"{lang}.json"
        check(f"locale/{lang}.json exists", f.is_file(), f)
        if not f.is_file():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            check(f"locale/{lang}.json parses", False, str(exc))
            continue
        meta = data.get("meta") or {}
        check(f"locale/{lang}.json has meta.title", bool(meta.get("title")), meta.get("title"))
        check(f"locale/{lang}.json has meta.description", bool(meta.get("description")), meta.get("description"))

    # ---- package.json wiring -------------------------------------------------
    pkg = json.loads((HERE.parent.parent / "package.json").read_text(encoding="utf-8"))
    check("package.json declares icon", pkg.get("icon") == "./icon.svg", pkg.get("icon"))
    exports = pkg.get("exports") or {}
    check("package.json exports ./icon", "./icon" in exports, list(exports)[:4])
    check("package.json exports locale globs", "./locale/*.json" in exports, "")
    files = pkg.get("files") or []
    check("package.json files ships icon.svg", "icon.svg" in files, files)
    check("package.json files ships locale", any(f.startswith("locale") for f in files), files)

    print(f"\n{len(fails)} failed" if fails else "\nall icon/flow checks passed")
    return 1 if fails else 0


def main() -> None:
    icon = draw_icon_raster()
    icon.save(HERE / "icon.png")
    # newline="" so the SVG lands with LF on Windows too: the repo stores LF
    # (`.gitattributes`: * text=auto eol=lf) and CRLF here would show up as a
    # spurious diff after every regeneration.
    (HERE / "icon.svg").write_text(write_icon_svg(), encoding="utf-8", newline="")
    # the bundle icon DSH's plugin page renders: package root, transparent, 36 viewBox
    (HERE.parent.parent / "icon.svg").write_text(write_plugin_icon_svg(), encoding="utf-8", newline="")
    draw_flow().save(HERE / "bridge-flow.png")
    for p in ("icon.png", "icon.svg", "bridge-flow.png"):
        print(f"wrote {p}  {(HERE / p).stat().st_size} bytes")
    print(f"wrote ../icon.svg  {(HERE.parent.parent / 'icon.svg').stat().st_size} bytes (bundle icon)")
    raise SystemExit(self_check())


if __name__ == "__main__":
    main()
