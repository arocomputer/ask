#!/bin/sh
# Installs ask from its GitHub release: the archive for this computer, checked against the
# release's checksums, into ~/.local/bin (or $ASK_INSTALL_DIR). Run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh -s -- --version v0.1.0
#
# $ASK_RELEASES replaces https://github.com/arocomputer/ask/releases, for testing.
set -eu

releases=${ASK_RELEASES:-https://github.com/arocomputer/ask/releases}
dir=${ASK_INSTALL_DIR:-$HOME/.local/bin}
version=${ASK_VERSION:-}

fail() { echo "ask install: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --version) [ $# -ge 2 ] || fail "--version needs a version, like v0.1.0"; version=$2; shift 2 ;;
    --version=*) version=${1#--version=}; shift ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a folder"; dir=$2; shift 2 ;;
    -h|--help)
      cat <<'HELP'
Install ask on macOS or Linux from a checksum-verified GitHub release.

Usage
  curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh -s -- [options]

Options
  --version vX.Y.Z   Install a specific release (default: latest, or ASK_VERSION)
  --dir DIR         Installation folder (default: ~/.local/bin, or ASK_INSTALL_DIR)
  -h, --help        Show this help without installing anything

Run the installer again to update, or use ask update. Then run ask setup.
HELP
      exit 0 ;;
    *) fail "unknown option $1; options: --version vX.Y.Z, --dir DIR" ;;
  esac
done

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "ask runs on macOS and Linux; this is $(uname -s)" ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) fail "ask is built for arm64 and x86_64; this is $(uname -m)" ;;
esac

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "needs curl or wget"; fi
}

if [ -z "$version" ]; then
  # The latest release redirects to its tag; read the tag from where it lands.
  if command -v curl >/dev/null 2>&1; then
    landing=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") || fail "could not reach $releases"
  else
    landing=$(wget -q --max-redirect=5 --server-response --spider "$releases/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tail -1 | tr -d '\r')
  fi
  version=${landing##*/}
fi
case $version in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  [0-9]*.[0-9]*.[0-9]*) version=v$version ;;
  *) fail "could not tell the latest version from $releases (got \"$version\")" ;;
esac

if [ -L "$dir/ask" ] || [ -e "$dir/.ask-installed-by" ]; then
  fail "$dir/ask belongs to a package manager; update it there, or choose another folder with --dir"
fi

archive="ask_${version}_${os}_${arch}.tar.gz"
work=$(mktemp -d "${TMPDIR:-/tmp}/ask-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

echo "Installing ask $version for $os/$arch"
fetch "$releases/download/$version/$archive" "$work/$archive" || fail "could not download $archive"
fetch "$releases/download/$version/checksums.txt" "$work/checksums.txt" || fail "could not download checksums.txt"

expected=$(grep " $archive\$" "$work/checksums.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/$archive" | cut -d' ' -f1)
else actual=$(shasum -a 256 "$work/$archive" | cut -d' ' -f1); fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  fail "checksum mismatch for $archive; refusing to install"
fi

tar -xzf "$work/$archive" -C "$work" ask
if [ ! -f "$work/ask" ] || [ -L "$work/ask" ]; then
  fail "$archive has no ask binary"
fi
got=$("$work/ask" --version 2>/dev/null || true)
[ "$got" = "$version" ] || fail "$archive says it is \"$got\", not $version"

mkdir -p "$dir"
cp "$work/ask" "$dir/.ask.next"
chmod 755 "$dir/.ask.next"
mv -f "$dir/.ask.next" "$dir/ask"
echo "Installed $dir/ask"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example in ~/.zshrc or ~/.bashrc:"
     echo "  export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Next: ask setup"
