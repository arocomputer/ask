"""Draws the README hero as an SVG: one dark ask terminal on a deep blue field. Edit the
transcript at the bottom, then run `python3 assets/screens/render.py assets/screens` from the
repository root. The single `hero.svg` reads on both GitHub themes."""
import html, sys

# GitHub's dark palette for the terminal, plus the hero's field and traffic lights.
FIELD = "#005f8f"
FG, DIM, BOLD, GREEN, RED = "#e6edf3", "#8b949e", "#ffffff", "#3fb950", "#f85149"
BG, BAR, BORDER = "#0d1117", "#161b22", "#30363d"
DOTS = ("#ff5f57", "#febc2e", "#28c840")
FONT, TITLE_FONT = 21, 14
CW, LH, PADX, TOP, BOTTOM = 12.6, 40, 40, 88, 40
W, H = 1400, 800

def render(lines, title, path):
    """Draw one centered terminal window, sized to the widest transcript line."""
    width = max(len("".join(s if isinstance(s, str) else s[0] for s in line)) for line in lines)
    w = int(PADX * 2 + max(width, 72) * CW)
    h = TOP + len(lines) * LH + BOTTOM
    x0, y0 = (W - w) // 2, (H - h) // 2
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
           f'<rect width="{W}" height="{H}" fill="{FIELD}"/>',
           f'<g transform="translate({x0} {y0})">',
           f'<rect x="0.5" y="0.5" width="{w-1}" height="{h-1}" rx="14" fill="{BG}" stroke="{BORDER}"/>',
           f'<path d="M1 14 a13 13 0 0 1 13 -13 h{w-29} a13 13 0 0 1 13 13 v31 h-{w-2} z" fill="{BAR}"/>',
           f'<line x1="1" y1="45" x2="{w-1}" y2="45" stroke="{BORDER}"/>']
    for x, color in zip((24, 46, 68), DOTS):
        out.append(f'<circle cx="{x}" cy="23" r="7" fill="{color}"/>')
    out.append(f'<text x="{w/2}" y="28" fill="{DIM}" font-size="{TITLE_FONT}" text-anchor="middle" font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif">{html.escape(title)}</text>')
    out.append(f'<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="{FONT}">')
    for n, line in enumerate(lines):
        y = TOP + n * LH
        x = PADX
        parts = []
        for seg in line:
            text, style = (seg, "") if isinstance(seg, str) else seg
            fill, weight = FG, "400"
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
    out.append('</g></g></svg>')
    open(path, "w").write("\n".join(out) + "\n")

D = lambda s: (s, "dim")
B = lambda s: (s, "bold")
G = lambda s: (s, "green")
P = ("$ ", "prompt")

dest = sys.argv[1]

render([
    [P, B('ask --wait -m claude:sonnet-5.5 "Why does the login test fail?"')],
    ["ask login-test-fail · ", G("succeeded"), D(" · Sonnet 5.5 · 48.0s · $0.09")],
    ["The expiry check compares seconds with milliseconds, auth/token.go:42."],
    [""],
    [P, B('ask continue login-test-fail --wait -w "Fix it, then run the test."')],
    ["ask login-test-fail · ", G("succeeded"), D(" · Sonnet 5.5 · 1:12 · 1 file changed · $0.14")],
    ["Fixed: the expiry is now in milliseconds. go test ./auth passes."],
    [""],
    [P, B("ask batch --wait -w --worktree review.json")],
    [B("ask review-session-code · batch of 3 · 3 at a time")],
    [G("✔ "), "claude    ", "Sonnet 5.5          ", D("2:31 · 2 files changed · $0.24")],
    [G("✔ "), "codex     ", "GPT-6.1 Sol         ", D("3:05 · 3 files changed")],
    [D("⠹ "), "opencode  ", "Deepseek 4.1 Flash  ", D("write · worktree · 1:48")],
    [D("2 succeeded · 0 failed · 3:05 · reported: 173.5k in · 5.7k out")],
], "ask", f"{dest}/hero.svg")
