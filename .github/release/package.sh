#!/bin/sh
# Build and verify the same four archives in CI and before publication. Never execute a
# cross-compiled binary; inspect its Go build metadata and run --version only on the host.
set -eu

fail() { printf 'package: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 2 ] || fail 'usage: .github/release/package.sh vX.Y.Z OUTPUT_DIRECTORY'
tag=$1
out=$2
case $tag in *[!v0-9.rc-]* | '') fail 'invalid version' ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$' ||
    fail 'expected vX.Y.Z or vX.Y.Z-rc.N without leading zeros'
[ -n "$out" ] || fail 'output directory is empty'
mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || fail 'output directory must be empty (no stale release assets)'
work=$(mktemp -d "${TMPDIR:-/tmp}/ask-package.XXXXXX")
trap 'rm -rf "$work"' EXIT
export CGO_ENABLED=0
host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)

for os in linux darwin; do
    for arch in amd64 arm64; do
        target="ask_${tag}_${os}_${arch}"
        stage="$work/$target"
        unpack="$work/verify-$target"
        archive="$out/$target.tar.gz"
        mkdir -p "$stage" "$unpack"
        GOOS="$os" GOARCH="$arch" ./x build -trimpath -ldflags "-s -w -X main.version=${tag}" -o "$stage/ask" .
        cp LICENSE "$stage/"
        tar -C "$stage" -czf "$archive" ask LICENSE
        printf '%s\n' ask LICENSE > "$work/expected"
        tar -tzf "$archive" > "$work/members"
        diff -u "$work/expected" "$work/members"
        tar -C "$unpack" -xzf "$archive"
        [ -f "$unpack/ask" ] && [ -x "$unpack/ask" ]
        cmp "$stage/ask" "$unpack/ask"
        cmp LICENSE "$unpack/LICENSE"
        go version -m "$unpack/ask" > "$work/metadata"
        grep -q "GOOS=$os\$" "$work/metadata" || fail "wrong OS in $target"
        grep -q "GOARCH=$arch\$" "$work/metadata" || fail "wrong architecture in $target"
        grep -q 'CGO_ENABLED=0$' "$work/metadata" || fail "CGO enabled in $target"
        if [ "$os/$arch" = "$host_os/$host_arch" ]; then
            [ "$(ASK_NO_UPDATE_CHECK=1 "$unpack/ask" --version)" = "$tag" ] || fail "wrong version in $target"
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
