"""Draws screen.png, the README's hero: the ask lockup and tagline in white on orange, above a
dark terminal window showing a session. One image reads on GitHub's light and dark themes alike.
Edit the transcript below, then run python3 .github/brand/render.py from the repository root.
It turns the drawing into a PNG with rsvg-convert (brew install librsvg)."""
import html, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ORANGE, WHITE = "#f2611d", "#ffffff"
TERM = dict(fg="#e6edf3", dim="#8b949e", bold="#ffffff", green="#3fb950", red="#f85149", yellow="#d29922",
            bg="#0d1117", bar="#161b22", border="#30363d", dot="#30363d")
FONT = "Menlo, SFMono-Regular, DejaVu Sans Mono, Consolas, monospace"
W, PAD, CW, LH = 1040, 56, 8.4, 22

D = lambda s: (s, "dim")
B = lambda s: (s, "bold")
G = lambda s: (s, "green")
Y = lambda s: (s, "yellow")
P = ("$ ", "dim")

# The transcript: a read session, its answer, and a write turn in the same session.
LINES = [
    [P, B('ask "Why does the login test fail?"')],
    ["k3f9a2"],
    [Y("!"), " ", B("k3f9a2"), " started · GLM 5.3", D(" · ask wait k3f9a2")],
    [P, B("ask wait k3f9a2")],
    [G("✓ succeeded"), " ", B("k3f9a2"), " · GLM 5.3", D(" · 48.0s · 31.0k in · 812 out · $0.09")],
    ["The expiry check compares seconds with milliseconds, auth/token.go:42."],
    [""],
    [P, B('ask continue k3f9a2 --wait -w "Fix it, then run the test."')],
    [G("✓ succeeded"), " ", B("k3f9a2"), " · GLM 5.3 · turn 2 · write", D(" · 1:12 · 1 file changed · $0.14")],
    ["Fixed: the expiry is now in milliseconds. go test ./auth passes."],
]


def lockup(x, y, height):
    """The lockup's outlines from lockup.svg, in white, at (x, y) and the given height."""
    src = open(os.path.join(HERE, "lockup.svg")).read()
    paths = "\n".join(re.findall(r"<path[^>]*/>", src))
    scale = height / 100.38
    return f'<g transform="translate({x} {y}) scale({scale:.4f})" fill="{WHITE}">{paths}</g>'


def terminal(x, y, width):
    c = TERM
    h = 44 + len(LINES) * LH + 18
    out = [f'<rect x="{x}" y="{y}" width="{width}" height="{h}" rx="12" fill="{c["bg"]}" stroke="{c["border"]}"/>',
           f'<path d="M{x} {y + 12} a12 12 0 0 1 12 -12 h{width - 24} a12 12 0 0 1 12 12 v22 h-{width} z" fill="{c["bar"]}"/>',
           f'<line x1="{x}" y1="{y + 34}" x2="{x + width}" y2="{y + 34}" stroke="{c["border"]}"/>']
    for dx in (20, 40, 60):
        out.append(f'<circle cx="{x + dx}" cy="{y + 17}" r="6" fill="{c["dot"]}"/>')
    out.append(f'<g font-family="{FONT}" font-size="14">')
    for n, line in enumerate(LINES):
        ty = y + 62 + n * LH
        cx = x + 24
        parts = []
        for seg in line:
            text, style = (seg, "") if isinstance(seg, str) else seg
            fill, weight = c["fg"], "400"
            if style == "dim": fill = c["dim"]
            if style == "bold": fill, weight = c["bold"], "700"
            if style in ("green", "red", "yellow"): fill = c[style]
            lead = len(text) - len(text.lstrip(" "))
            body = text.lstrip(" ")
            if body:
                t = html.escape(body).replace(" ", "&#160;")
                parts.append(f'<tspan x="{cx + lead * CW:.1f}" fill="{fill}" font-weight="{weight}">{t}</tspan>')
            cx += len(text) * CW
        out.append(f'<text y="{ty}">{"".join(parts)}</text>')
    out.append("</g>")
    return "\n".join(out), h


def main():
    term, th = terminal(PAD, 176, W - 2 * PAD)
    height = 176 + th + PAD
    svg = "\n".join([
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" viewBox="0 0 {W} {height}">',
        f'<rect width="{W}" height="{height}" fill="{ORANGE}"/>',
        lockup(PAD, 52, 48),
        f'<text x="{PAD}" y="140" fill="{WHITE}" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="22" font-weight="600">Subagents for your agents.</text>',
        term,
        "</svg>",
    ])
    png = os.path.join(HERE, "screen.png")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "screen.svg")
        open(src, "w").write(svg)
        if not shutil.which("rsvg-convert"):
            sys.exit("render.py: install librsvg for rsvg-convert, like brew install librsvg")
        subprocess.run(["rsvg-convert", "--zoom", "2", "-o", png, src], check=True)
    print(png)


if __name__ == "__main__":
    main()
