"""Draws screen.png, the README's hero: a dark terminal on an orange field, which reads on
GitHub's light and dark themes alike. Edit the transcript at the bottom, then run
python3 .github/brand/render.py from the repository root. It turns the drawing into a PNG with
rsvg-convert (brew install librsvg)."""
import html
import os
import shutil
import subprocess
import sys
import tempfile

# A dark terminal on an orange field, with the proportions of a desktop terminal screenshot.
W, H = 1400, 907
WINDOW_W, WINDOW_H = 1150, 660
FONT, CW, LINE_HEIGHT = 31, 18.6, 54
PAD, TOP = 40, 175
COLORS = {
    "text": "#d1d5d6", "dim": "#969b9c", "prompt": "#d798d8",
    "success": "#86b7a2", "id": "#ffffff",
}
MONO = "Menlo, SFMono-Regular, DejaVu Sans Mono, Consolas, monospace"


def draw(lines):
    """One centered terminal illustration; each line holds (text, color) segments."""
    x0, y0 = (W - WINDOW_W) // 2, (H - WINDOW_H) // 2
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        '<rect width="100%" height="100%" fill="#f08a2c"/>',
        '<defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">'
        '<feGaussianBlur stdDeviation="35"/></filter></defs>',
        f'<g transform="translate({x0} {y0})">',
        f'<rect x="0" y="35" width="{WINDOW_W}" height="{WINDOW_H}" rx="11" '
        'fill="#000" opacity="0.32" filter="url(#shadow)"/>',
        f'<rect width="{WINDOW_W}" height="{WINDOW_H}" rx="11" fill="#151718"/>',
    ]
    for x, color in zip((47, 91, 135), ("#ff5f57", "#febc2e", "#28c840")):
        out.append(f'<circle cx="{x}" cy="48" r="14" fill="{color}"/>')
    out.append(f'<g font-family="{MONO}" font-size="{FONT}">')
    for n, line in enumerate(lines):
        x = PAD
        spans = []
        for text, color in line:
            # Renderers drop a span's leading spaces, so start the span after them instead.
            lead = len(text) - len(text.lstrip(" "))
            body = html.escape(text.lstrip(" ")).replace(" ", "&#160;")
            if body:
                spans.append(f'<tspan x="{x + lead * CW:.1f}" fill="{COLORS[color]}">{body}</tspan>')
            x += len(text) * CW
        if x > WINDOW_W - PAD:
            sys.exit(f"render.py: transcript line {n + 1} exceeds the terminal width")
        out.append(f'<text y="{TOP + n * LINE_HEIGHT}">{"".join(spans)}</text>')
    out.append('</g></g></svg>')
    return "\n".join(out) + "\n"


# A read session finds the bug; a second turn in the same session fixes it.
LINES = [
    [("$ ", "prompt"), ('ask --wait "Why does login fail?"', "text")],
    [("✓ ", "success"), ("k3f9a2", "id"), (" · GLM 5.3", "text"), (" · 48s", "dim")],
    [("The expiry check compares seconds with", "text")],
    [("milliseconds in auth/token.go:42.", "text")],
    [],
    [("$ ", "prompt"), ('ask continue k3f9a2 --wait -w "Fix it."', "text")],
    [("✓ ", "success"), ("k3f9a2", "id"), (" · GLM 5.3 · turn 2 · write", "text"), (" · 1 file changed", "dim")],
    [("Fixed: the expiry is now in milliseconds.", "text")],
    [("go test ./auth passes.", "text")],
]


def main():
    if not shutil.which("rsvg-convert"):
        sys.exit("render.py: install librsvg for rsvg-convert, like brew install librsvg")
    png = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screen.png")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "screen.svg")
        with open(src, "w", encoding="utf-8") as f:
            f.write(draw(LINES))
        subprocess.run(["rsvg-convert", "-o", png, src], check=True)
    print(png)


if __name__ == "__main__":
    main()
