#!/bin/sh
# Build the pinned, unmodified bubblewrap/libcap sources for both Linux architectures.
# No setuid bit, SELinux integration or runtime shared-library dependencies. Source and license
# material travels with every binary. Rebuild offline: sh build.sh OUTPUT EXTRACTED_SOURCES.
set -eu
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo 'usage: bubblewrap.sh OUTPUT [SOURCES]' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'build the Linux bundle on Linux' >&2; exit 1; }
mkdir -p "$1"
out=$(cd "$1" && pwd)
sources=${2:-}
work=$(mktemp -d "${TMPDIR:-/tmp}/ask-bubblewrap.XXXXXX")
trap 'rm -rf "$work"' EXIT
if command -v zig >/dev/null 2>&1; then zig=$(command -v zig)
else zig=$(python3 -c 'import os, ziglang; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))'); fi
mkdir "$work/sources"

# Check the pinned digest even for locally supplied source archives.
fetch() {
    name=$1 url=$2 digest=$3
    if [ -n "$sources" ]; then cp "$sources/$name" "$work/sources/$name"
    else curl --fail --location --retry 3 "$url" -o "$work/sources/$name"; fi
    printf '%s  %s\n' "$digest" "$work/sources/$name" | sha256sum --check -
}
fetch bubblewrap-0.13.1.tar.xz \
    https://github.com/containers/bubblewrap/releases/download/v0.13.1/bubblewrap-0.13.1.tar.xz \
    0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d
fetch libcap-2.78.tar.xz \
    https://mirrors.edge.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.78.tar.xz \
    0d621e562fd932ccf67b9660fb018e468a683d7b827541df27813228c996bb11

for cpu in x64 arm64; do
    case $cpu in x64) triple=x86_64-linux-musl ;; arm64) triple=aarch64-linux-musl ;; esac
    mkdir "$work/$cpu"
    tar -xf "$work/sources/bubblewrap-0.13.1.tar.xz" -C "$work/$cpu"
    tar -xf "$work/sources/libcap-2.78.tar.xz" -C "$work/$cpu"
    cap="$work/$cpu/libcap-2.78/libcap"
    make -C "$cap" libcap.a BUILD_CC=cc CC="$zig cc -target $triple" \
        AR="$zig ar" RANLIB="$zig ranlib" SHARED=no PTHREADS=no USE_GPERF=no
    bwrap="$work/$cpu/bubblewrap-0.13.1"
    printf '%s\n' '#define PACKAGE_STRING "bubblewrap 0.13.1"' > "$bwrap/config.h"
    # The same source list as upstream meson.build, with optional SELinux support disabled.
    "$zig" cc -target "$triple" -static -O2 -s -D_GNU_SOURCE -I"$bwrap" -I"$cap/include" \
        "$bwrap/bubblewrap.c" "$bwrap/bind-mount.c" "$bwrap/network.c" "$bwrap/utils.c" \
        "$bwrap/chroot_realpath.c" "$bwrap/safe_openat.c" "$cap/libcap.a" -o "$work/ask.bwrap-$cpu"
    chmod 755 "$work/ask.bwrap-$cpu"
    mv "$work/ask.bwrap-$cpu" "$out/ask.bwrap-$cpu"
done

cp "$0" "$work/sources/build.sh"
cp "$bwrap/COPYING" "$work/sources/bubblewrap.LICENSE"
cp "$cap/../License" "$work/sources/libcap.LICENSE"
ziglib=$("$zig" env | python3 -c 'import json,re,sys; print(json.loads(re.search(r"\.?\"?lib_dir\"?\s*[:=]\s*(\"[^\"]+\")", sys.stdin.read())[1]))')
cp "$ziglib/libc/musl/COPYRIGHT" "$work/sources/musl.LICENSE"
cp "$(dirname "$ziglib")/LICENSE" "$work/sources/zig.LICENSE"
cat > "$work/sources/NOTICE" <<EOF
ask.bwrap: bubblewrap 0.13.1 (LGPL-2.1-or-later), libcap 2.78 (BSD-3-Clause option),
statically linked with musl and Zig runtime support. Upstream sources are unmodified.
Built with Zig $("$zig" version). Rebuild on Linux with make, cc, Zig, tar and Python 3:
  sh build.sh OUTPUT .
The accompanying archives contain complete bubblewrap/libcap sources and copyright notices.
This helper is a separate executable; ask's own code remains MIT licensed.
EOF
tar -C "$work/sources" -czf "$out/ask.sandbox.sources.tar.gz" .
