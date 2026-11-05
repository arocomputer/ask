# Releases

A release is a stable `vX.Y.Z` tag (without leading zeros) on a commit with successful push CI
on main. Everything after the tag is automatic. Release scripts live in `.github/release/`;
the general architectural guard lives in `.github/checks/`.

## Cutting one

From a clean, up-to-date main checkout, with git and the authenticated GitHub CLI (`gh`)
installed. Choose a tag that has not been released:

```sh
tag=v0.3.0                  # replace with the next release's version
./x release "$tag"        # opens a PR naming CHANGELOG.md's Unreleased section
# Merge the PR, then update your main checkout before running it again.
git pull --ff-only
./x release "$tag"        # checks CI passed on main, then dispatches Actions with that SHA
```

The first run requires exactly one nonempty Unreleased section and leaves a fresh, empty
Unreleased heading above the release notes. The second requires exactly one nonempty section
for the tag. If main advances between the CI check and dispatch, Actions refuses to tag it;
update main, wait for its push CI, and retry. Existing tags and release branches are rejected.

## What the tag runs

`.github/workflows/release.yml` creates the tag after checking main, the changelog, and CI. The
tag starts the build and publication jobs:

1. **check**: the stable tag is on main, its exact commit passed main push CI, and
   `CHANGELOG.md` has exactly one nonempty section for it; `./x check` and `./x audit`.
   Maintainer-pushed tags pass the same gates.
2. **release**: `.github/release/package.sh` builds and verifies archives for macOS and Linux
   (arm64 and amd64), preserving `ask_vX.Y.Z_OS_ARCH.tar.gz` names and the embedded version.
   The archives and `checksums.txt` receive build provenance; the GitHub release uses the
   changelog section as its notes. The generated formula must pass Ruby syntax checking
   before publication.
3. **formula**: regenerates `ask.rb` (`.github/release/formula.sh`) for the release, checks its
   Ruby syntax and pushes it to main.
   Formula jobs run one at a time and skip tags that are no longer GitHub's latest stable release,
   checking both before generation and immediately before pushing. If main advances during
   generation, the push fails; rerun the formula job from the latest release. An unchanged
   formula needs no commit.
4. **install**: a real `install.sh` install of the release on both systems.

When the run record format changed, pin a record from the release in `src/test/fixtures/run-vX.Y.Z/`.

## Checking without publishing

`./x check` needs Go, Node.js, ShellCheck, actionlint and Ruby on PATH. It checks workflow syntax
(`./x workflows`) and the committed formula, alongside the existing offline checks. CI installs
a pinned actionlint version and additionally runs `./x test -race ./src/...` on Linux;
the black-box tests build their own subprocesses without race instrumentation.

CI exercises the real packaging and formula scripts before any release. To do the same locally,
from the repository root, with dependencies already cached:

```sh
out=$(mktemp -d)
GOPROXY=off .github/release/package.sh v0.0.0 "$out"
.github/release/formula.sh v0.0.0 "$out/checksums.txt" > "$out/ask.rb"
ruby -c "$out/ask.rb"
rm -rf "$out"
```

Packaging requires an empty output directory so stale assets cannot be published. It builds
with CGO disabled, verifies that each archive contains only the executable `ask` and `LICENSE`,
compares extracted contents, inspects target build metadata, runs `--version` only for a
matching host target, and checks all four SHA-256 entries. It uses `sha256sum` or macOS's
`shasum`. Formula generation requires one valid checksum per exact archive name and rejects
invalid input before emitting Ruby. These checks require no GitHub credentials or publication.

## Where people get it

- `curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh`: `install.sh` from main, which downloads
  the latest release and checks its checksum.
- `brew install`: from `ask.rb` at the top of this repository, which Homebrew reads as a tap.
- `go install github.com/arocomputer/ask@latest`.
- `ask update`, for a direct install.
