# Releases

A release is a `v*` tag on main. Everything after the tag is automatic.

## Cutting one

From a clean, up-to-date main checkout, with git and the authenticated GitHub CLI (`gh`)
installed. Choose a tag that has not been released:

```sh
tag=v0.3.0                  # replace with the next release's version
scripts/release.sh "$tag"  # opens a PR naming CHANGELOG.md's Unreleased section
# Merge the PR, then update your main checkout before running it again.
git pull --ff-only
scripts/release.sh "$tag"  # checks CI passed on main, then dispatches Actions
```

## What the tag runs

`.github/workflows/release.yml` creates the tag after checking main, the changelog, and CI. The
tag starts the build and publication jobs:

1. **check**: the tag is on main and `CHANGELOG.md` has its section; `./x check` and `./x audit`.
2. **release**: archives for macOS and Linux (arm64 and amd64) with checksums and build
   provenance; the GitHub release, with the changelog section as its notes.
3. **formula**: regenerates `ask.rb` (`scripts/formula.sh`) for the release and pushes it to main.
4. **install**: a real `install.sh` install of the release on both systems.

When the run record format changed, pin a record from the release in `test/fixtures/run-vX.Y.Z/`.

## Where people get it

- `curl -fsSL https://fschrhunt.com/ask/install.sh | sh`: `install.sh` from main, which downloads
  the latest release and checks its checksum.
- `brew install`: from `ask.rb` at the top of this repository, which Homebrew reads as a tap.
- `go install github.com/arocomputer/ask/cmd/ask@latest`.
- `ask update`, for a direct install.
