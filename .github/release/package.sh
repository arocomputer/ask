#!/bin/sh
# Build and verify the same four archives in CI and before publication: ask compiled by Bun
# into one file for each system, with the license; the Linux ones also hold sandybox, the
# sandbox helper, compiled statically by zig for each architecture into native/build, where the
# npm package picks it up too. The version comes from the tag, set in package.json for the
# build and restored after. Only the host's binaries run, to check them; the others are checked
# by file type.
set -eu

fail() { printf 'package: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 2 ] || fail 'usage: .github/release/package.sh vX.Y.Z OUTPUT_DIRECTORY'
tag=$1
out=$2
case $tag in *[!v0-9.rc-]* | '') fail 'invalid version' ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$' ||
    fail 'expected vX.Y.Z or vX.Y.Z-rc.N without leading zeros'
[ -n "$out" ] || fail 'output directory is empty'
command -v bun >/dev/null 2>&1 || fail 'needs bun on PATH'
zigcc() {
    if command -v zig >/dev/null 2>&1; then zig cc "$@"
    elif python3 -c 'import ziglang' 2>/dev/null; then python3 -m ziglang cc "$@"
    else fail 'needs zig on PATH (or pip install ziglang) to build sandybox'
    fi
}
mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || fail 'output directory must be empty (no stale release assets)'
out=$(cd "$out" && pwd)
cd "$(dirname "$0")/../.."
work=$(mktemp -d "${TMPDIR:-/tmp}/ask-package.XXXXXX")
cp package.json "$work/package.json"
trap 'cp "$work/package.json" package.json; rm -rf "$work"' EXIT
version=${tag#v}
npm pkg set version="$version"

host_os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in x86_64 | amd64) host_arch=amd64 ;; aarch64 | arm64) host_arch=arm64 ;; *) host_arch=other ;; esac

mkdir -p native/build
for cpu in x64 arm64; do
    case $cpu in x64) triple=x86_64-linux-musl ;; arm64) triple=aarch64-linux-musl ;; esac
    zigcc -target "$triple" -static -s -std=c11 -O2 -Wall -Werror -o "native/build/sandybox-$cpu" native/sandybox.c
done

for os in linux darwin; do
    for arch in amd64 arm64; do
        target="ask_${tag}_${os}_${arch}"
        stage="$work/$target"
        unpack="$work/verify-$target"
        archive="$out/$target.tar.gz"
        mkdir -p "$stage" "$unpack"
        case $arch in amd64) cpu=x64 ;; arm64) cpu=arm64 ;; esac
        bun build --compile --minify --target="bun-$os-$cpu" src/cli.ts --outfile "$stage/ask" >/dev/null
        cp LICENSE "$stage/"
        members="ask LICENSE"
        if [ "$os" = linux ]; then
            cp "native/build/sandybox-$cpu" "$stage/sandybox"
            members="ask sandybox LICENSE"
        fi
        # shellcheck disable=SC2086 # members is a word list on purpose
        tar -C "$stage" -czf "$archive" $members
        # shellcheck disable=SC2086
        printf '%s\n' $members > "$work/expected"
        tar -tzf "$archive" > "$work/members"
        diff -u "$work/expected" "$work/members"
        tar -C "$unpack" -xzf "$archive"
        [ -f "$unpack/ask" ] && [ -x "$unpack/ask" ]
        cmp "$stage/ask" "$unpack/ask"
        cmp LICENSE "$unpack/LICENSE"
        case $os/$arch in
            linux/amd64) kind='ELF 64-bit.*x86-64' ;;
            linux/arm64) kind='ELF 64-bit.*(aarch64|ARM)' ;;
            darwin/amd64) kind='Mach-O 64-bit.*x86_64' ;;
            darwin/arm64) kind='Mach-O 64-bit.*arm64' ;;
        esac
        file "$unpack/ask" | grep -Eq "$kind" || fail "$target is not a $os/$arch binary: $(file -b "$unpack/ask")"
        if [ "$os" = linux ]; then
            file "$unpack/sandybox" | grep -Eq "$kind.*statically linked" || fail "$target's sandybox is not a static $os/$arch binary: $(file -b "$unpack/sandybox")"
        fi
        if [ "$os/$arch" = "$host_os/$host_arch" ]; then
            got=$("$unpack/ask" --version)
            [ "$got" = "ask version $version" ] || fail "$target says \"$got\", not ask version $version"
            if [ "$os" = linux ]; then "$unpack/sandybox" --abi >/dev/null || fail "$target's sandybox doesn't run"; fi
        fi
    done
done
(
    cd "$out"
    # macOS ships shasum; Linux runners ship sha256sum. Both emit the installer's format.
    set -- "ask_${tag}_darwin_amd64.tar.gz" "ask_${tag}_darwin_arm64.tar.gz" \
        "ask_${tag}_linux_amd64.tar.gz" "ask_${tag}_linux_arm64.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -- "$@" > checksums.txt
        sha256sum --check checksums.txt
    else
        shasum -a 256 -- "$@" > checksums.txt
        shasum -a 256 --check checksums.txt
    fi
)
