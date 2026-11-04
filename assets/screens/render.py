"""Draws the README's terminal pictures as SVG windows in ask's look: black, white and greys, with
color only where it means something. Edit the transcripts at the bottom, then run
python3 assets/screens/render.py assets/screens from the repository root. Each picture is drawn
twice, light/NAME.svg and dark/NAME.svg, and the README shows the one matching the reader's theme."""
import html, sys

# GitHub's light and dark palettes, so each picture sits in its page: text, quiet text, strong text,
# green, red, window, title bar, border, dots, and the diff bands as (background, text).
THEMES = {
    "light": dict(fg="#1f2328", dim="#6e7781", bold="#000000", green="#1a7f37", red="#cf222e", bg="#ffffff",
                  bar="#f6f8fa", border="#d0d7de", dot="#d0d7de",
                  bands={"add": ("#dafbe1", "#116329"), "del": ("#ffebe9", "#82071e"), "file": ("#eaeef2", "#1f2328")}),
    "dark": dict(fg="#e6edf3", dim="#8b949e", bold="#ffffff", green="#3fb950", red="#f85149", bg="#0d1117",
                 bar="#161b22", border="#30363d", dot="#30363d",
                 bands={"add": ("#12261e", "#aff5b4"), "del": ("#2d1215", "#ffc0c0"), "file": ("#262c36", "#ffffff")}),
}
CW, LH, PADX, TOP = 8.4, 21, 22, 52

def render(lines, width_chars, title, path, theme):
    c = THEMES[theme]
    FG, DIM, BOLD, GREEN, RED, BANDS = c["fg"], c["dim"], c["bold"], c["green"], c["red"], c["bands"]
    w = int(PADX * 2 + width_chars * CW)
    h = TOP + len(lines) * LH + 4
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
           f'<rect x="0.5" y="0.5" width="{w-1}" height="{h-1}" rx="10" fill="{c["bg"]}" stroke="{c["border"]}"/>',
           f'<path d="M1 10.5 a9.5 9.5 0 0 1 9.5 -9.5 h{w-21} a9.5 9.5 0 0 1 9.5 9.5 v23.5 h-{w-2} z" fill="{c["bar"]}"/>',
           f'<line x1="1" y1="34" x2="{w-1}" y2="34" stroke="{c["border"]}"/>']
    for x in (18, 36, 54):
        out.append(f'<circle cx="{x}" cy="17" r="5.5" fill="{c["dot"]}"/>')
    out.append(f'<text x="{w/2}" y="21.5" fill="{DIM}" font-size="12.5" text-anchor="middle" font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif">{html.escape(title)}</text>')
    out.append(f'<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">')
    for n, line in enumerate(lines):
        y = TOP + n * LH
        band = None
        if line and isinstance(line[0], str) and line[0] in BANDS:
            band, line = line[0], line[1:]
            bg, _ = BANDS[band]
            out.append(f'<rect x="{PADX-8}" y="{y-15}" width="{w-2*PADX+16}" height="{LH}" fill="{bg}"/>')
        x = PADX
        parts = []
        for seg in line:
            text, style = (seg, "") if isinstance(seg, str) else seg
            fill, weight = FG, "400"
            if band:
                fill = BANDS[band][1]
            if style == "dim": fill = DIM
            if style == "bold": fill, weight = BOLD, "600"
            if style == "green": fill = GREEN
            if style == "red": fill = RED
            if style == "prompt": fill = DIM
            lead = len(text) - len(text.lstrip(" "))
            body = text.lstrip(" ")
            if body:
                t = html.escape(body).replace(" ", "&#160;")
                parts.append(f'<tspan x="{x + lead * CW:.1f}" fill="{fill}" font-weight="{weight}">{t}</tspan>')
            x += len(text) * CW
        out.append(f'<text y="{y}">{"".join(parts)}</text>')
    out.append('</g></svg>')
    open(path, "w").write("\n".join(out) + "\n")

D = lambda s: (s, "dim")
B = lambda s: (s, "bold")
G = lambda s: (s, "green")
R = lambda s: (s, "red")
P = ("$ ", "prompt")

dest = sys.argv[1]
import os
_render = render
def render(lines, width, title, path):
    for theme in THEMES:
        os.makedirs(os.path.join(os.path.dirname(path), theme), exist_ok=True)
        _render(lines, width, title, os.path.join(os.path.dirname(path), theme, os.path.basename(path)), theme)

render([
    [P, B('ask --model claude:sonnet-5.5 "Why does the login test fail?"')],
    ["ask login-test-fail · ", G("ok"), D(" · Sonnet 5.5 · 48.0s · 31.0k in · 812 out · $0.09")],
    ["The expiry check compares seconds with milliseconds, auth/token.go:42."],
    [""],
    [P, B('ask continue login-test-fail --write "Fix it, then run the test."')],
    ["ask login-test-fail · ", G("ok"), D(" · Sonnet 5.5 · 1:12 · 1 file changed · 44.2k in · 1.3k out · $0.14")],
    ["Fixed: the expiry is now in milliseconds. go test ./auth passes."],
], 92, "ask", f"{dest}/run.svg")

render([
    [P, B("ask batch -w --worktree review.json")],
    [B("ask review-session-code · batch of 3 · 3 at a time")],
    ["✔ ", "claude    ", "Sonnet 5.5          ", D("2:31 · 2 files changed · 61.2k in · 2.1k out · $0.24")],
    ["✔ ", "codex     ", "GPT-6.1 Sol         ", D("3:05 · 3 files changed · 88.4k in · 3.0k out")],
    [D("⠹ "), "opencode  ", "Deepseek 4.1 Flash  ", D("write · worktree · 1:48 · 23.9k in · 640 out · $0.004")],
    [D("2/3 ok · 3:05 · 173.5k in · 5.7k out")],
], 92, "ask batch", f"{dest}/batch.svg")

render([
    [B("ask settings"), D("  ~/.ask")],
    [""],
    [D("✔ "), "What do you want to change? ", B("Review and save")],
    [""],
    ["file", " ~/.ask/settings.json  ", G("+2"), " ", R("-1")],
    ["del", '    "timeout": 900'],
    ["add", '    "timeout": 1800,'],
    ["add", '    "max_cost": 2'],
    [""],
    ["file", " ~/.ask/models.json  ", G("+1")],
    ["add", '    "gpt-4o": false'],
    [""],
    ["2 files changed, ", G("3 insertions(+)"), ", ", R("1 deletion(-)")],
    [D("? "), B("Save these changes?"), D(" (Y/n)")],
], 92, "ask settings", f"{dest}/settings.svg")
