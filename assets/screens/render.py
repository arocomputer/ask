"""Render the README's illustrative terminal transcript as a self-contained SVG.

Run `python3 assets/screens/render.py assets/screens` from the repository root.
"""
import html
import sys
from pathlib import Path

# A dark terminal on an orange field, with the proportions of a desktop terminal screenshot.
W, H = 1400, 907
WINDOW_W, WINDOW_H = 1150, 660
FONT, CW, LINE_HEIGHT = 31, 18.6, 54
PAD, TOP = 40, 175
COLORS = {
    "text": "#d1d5d6", "dim": "#969b9c", "prompt": "#d798d8",
    "success": "#86b7a2",
}


def render(lines, path):
    """Write one centered terminal illustration; each line contains (text, color) segments."""
    x0, y0 = (W - WINDOW_W) // 2, (H - WINDOW_H) // 2
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        '<rect width="100%" height="100%" fill="#f5a04b"/>',
        '<defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">'
        '<feGaussianBlur stdDeviation="35"/></filter></defs>',
        f'<g transform="translate({x0} {y0})">',
        f'<rect x="0" y="35" width="{WINDOW_W}" height="{WINDOW_H}" rx="11" '
        'fill="#000" opacity="0.32" filter="url(#shadow)"/>',
        f'<rect width="{WINDOW_W}" height="{WINDOW_H}" rx="11" fill="#151718"/>',
    ]
    for x, color in zip((47, 91, 135), ("#ff5f57", "#febc2e", "#28c840")):
        out.append(f'<circle cx="{x}" cy="48" r="14" fill="{color}"/>')
    out.append(f'<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="{FONT}">')
    for n, line in enumerate(lines):
        x = PAD
        spans = []
        for text, color in line:
            spans.append(f'<tspan x="{x:.1f}" fill="{COLORS[color]}">{html.escape(text).replace(" ", "&#160;")}</tspan>')
            x += len(text) * CW
        if x > WINDOW_W - PAD:
            raise ValueError(f"transcript line {n + 1} exceeds the terminal width")
        out.append(f'<text y="{TOP + n * LINE_HEIGHT}">{"".join(spans)}</text>')
    out.append('</g></g></svg>')
    Path(path).write_text("\n".join(out) + "\n", encoding="utf-8")


render([
    [("$ ", "prompt"), ('ask --wait "Why does login fail?"', "text")],
    [],
    [("ask login-fail · ", "dim"), ("succeeded", "success"), (" · Sonnet 5.5 · 48s", "dim")],
    [("The expiry check compares seconds with", "text")],
    [("milliseconds in auth/token.go:42.", "text")],
    [],
    [("$ ", "prompt"), ('ask continue login-fail --wait -w "Fix it."', "text")],
    [],
    [("ask login-fail · ", "dim"), ("succeeded", "success"), (" · Sonnet 5.5 · 1 file changed", "dim")],
], Path(sys.argv[1]) / "hero.svg")
