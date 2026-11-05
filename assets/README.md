# ask assets

Each folder contains the same three SVG marks in one color. The black set uses GitHub's light-theme
default text color (`#1f2328`); the white set uses the dark README text color (`#d1d7e0`) shown in
the dark-dimmed theme. They are the brand marks, available for docs and other uses.

| Mark | Black | White | Use |
| --- | --- | --- | --- |
| Lockup | [SVG](black/lockup.svg) | [SVG](white/lockup.svg) | Wordmark with symbol |
| Wordmark | [SVG](black/wordmark.svg) | [SVG](white/wordmark.svg) | ask lettering |
| Logo | [SVG](black/logo.svg) | [SVG](white/logo.svg) | Rounded square with a cursor bar |

The SVGs have transparent backgrounds and no font or raster dependencies. Scale them proportionally
and leave surrounding space in the layout. The black and white variants share the same geometry.

`screens/hero.svg` is the README's hero: one dark terminal window on a light-orange field
(`#f5a04b`). It uses fixed colors, so the same file reads in both GitHub themes. Edit the transcript
at the bottom of `screens/render.py` and run
`python3 assets/screens/render.py assets/screens` to redraw it.
