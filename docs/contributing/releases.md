# Releases

A release is a `vX.Y.Z` tag (without leading zeros) on a commit with successful push CI on
main. Everything after the tag is automatic. A `vX.Y.Z-rc.N` tag is a pre-release: it gets the
same checks and archives, is marked as such on GitHub, and neither "latest" nor the Homebrew
formula move to it. Release scripts live in `.github/release/`.

## Cutting one

From a clean, up-to-date main checkout, with git and the authenticated GitHub CLI (`gh`)
installed. Choose a tag that has not been released:

```sh
tag=v0.3.0                  # replace with the next release's version
.github/release/release.sh "$tag"   # opens a PR naming CHANGELOG.md's Unreleased section
# Merge the PR, then update your main checkout before running it again.
git pull --ff-only
.github/release/release.sh "$tag"   # checks CI passed on main, then dispatches Actions with that SHA
```

The first run requires exactly one nonempty Unreleased section and leaves a fresh, empty
Unreleased heading above the release notes. The second requires exactly one nonempty section
for the tag. If main advances between the CI check and dispatch, Actions refuses to tag it;
update main, wait for its push CI, and retry. Existing tags and release branches are rejected.

`.github/release/release.sh --dry-run vX.Y.Z` runs the same validation and then builds and verifies the
archives and the formula for that commit in Actions, tagging and publishing nothing. Use it to
rehearse a release or to check that the pipeline still works.

## What the tag runs

`.github/workflows/release.yml` creates the tag after checking main, the changelog, and CI. The
tag starts the build and publication jobs:

1. **check**: the stable tag is on main, its exact commit passed main push CI, and
   `CHANGELOG.md` has exactly one nonempty section for it; the typecheck, the tests under Node
   and Bun, ShellCheck and actionlint.
   Maintainer-pushed tags pass the same gates.
2. **release**: `.github/release/package.sh` compiles ask with Bun into one file for macOS and
   Linux (arm64 and amd64), in archives named `ask_vX.Y.Z_OS_ARCH.tar.gz`, with the version
   from the tag. The Linux archives also hold `ask.sandbox`, which `zig cc` compiles statically
   from `native/sandbox.c` for each architecture into `native/build/`, where `npm run build`
   picks it up for the npm package; the workflow installs zig with `pip install ziglang`.
   The archives and `checksums.txt` receive build provenance; the GitHub release uses the
   changelog section as its notes. The generated formula must pass Ruby syntax checking
   before publication.
3. **formula**: regenerates `ask.rb` (`.github/release/formula.sh`) for the release, checks its
   Ruby syntax and pushes it to main.
   Formula jobs run one at a time and skip tags that are not GitHub's latest stable release
   (a pre-release never is),
   checking both before generation and immediately before pushing. If main advances during
   generation, the push fails; rerun the formula job from the latest release. An unchanged
   formula needs no commit.
4. **install**: a real `install.sh` install of the release on both systems.

## Checking without publishing

CI runs the typecheck and the tests under Node and Bun on Linux and macOS, ShellCheck on the
scripts, actionlint on the workflows, and the real packaging and formula scripts. To package
locally, from the repository root, with Bun and npm on PATH:

```sh
out=$(mktemp -d)
.github/release/package.sh v0.0.0 "$out"
.github/release/formula.sh v0.0.0 "$out/checksums.txt" > "$out/ask.rb"
ruby -c "$out/ask.rb"
rm -rf "$out"
```

Packaging requires an empty output directory so stale assets cannot be published. It sets the
version in `package.json` for the build and restores it after, verifies that each archive
contains only the executable `ask` and `LICENSE`, compares extracted contents, checks each
binary's system and architecture by its file type, runs `--version` only for the host's, and
checks all four SHA-256 entries. Formula generation requires one valid checksum per exact
archive name and rejects invalid input before emitting Ruby. None of this needs GitHub
credentials or publishes anything.

## Where people get it

- `curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh`: `install.sh` from main, which downloads
  the latest release and checks its checksum.
- `brew install`: from `ask.rb` at the top of this repository, which Homebrew reads as a tap.
- `npm install -g @arocomputer/ask`, once the package is published to npm; no workflow publishes
  it yet.
