#!/bin/sh
# One repository entry point. Local checks and CI run the same commands, so no environment has
# a private definition of "green".
set -eu
cd "$(dirname "$0")"

usage() {
    cat <<'EOF'
usage: ./x [command] [args...]
  check              Default; Go formatting, vet and tests, offline integration checks, shellcheck and architectural guards
  fmt [--check]      Format Go sources, or check without writing
  lint               Run go vet
  test [args...]     Forward arguments to go test (default: ./...)
  build [args...]    Forward arguments to go build (default: ./...)
  integration [names...]  Offline packaged-agent integration checks
  shell | guard      Shellcheck or architectural guards
  audit              Network vulnerability audit, separate from check
  dev [args...]      Build and run ask from this checkout
  hooks              Install the existing Git hooks
  help | --help | -h Show this help
EOF
}

# Reject invalid arguments before running any command that could write files.
invalid() { usage >&2; exit 2; }

command=${1-check}
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
    check|lint|shell|guard|audit|hooks) [ "$#" -eq 0 ] || invalid ;;
    fmt)
        [ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = "--check" ]; } || invalid
        ;;
    help|--help|-h) [ "$#" -eq 0 ] || invalid; usage; exit 0 ;;
esac

case "$command" in
    # Everything a pull request must pass, except audit, which needs the network.
    check)
        ./x fmt --check
        ./x lint
        ./x test
        ./x integration
        ./x shell
        ./x guard
        ;;
    fmt)
        if [ "${1:-}" = "--check" ]; then
            unformatted=$(gofmt -l .)
            if [ -n "$unformatted" ]; then
                printf 'format these with: gofmt -w %s\n' "$unformatted" >&2
                exit 1
            fi
        else
            gofmt -l -w .
        fi
        ;;
    lint) go vet ./... ;;
    test)
        if [ "$#" -eq 0 ]; then set -- ./...; fi
        go test "$@"
        ;;
    build)
        if [ "$#" -eq 0 ]; then set -- ./...; fi
        go build "$@"
        ;;
    # Offline adapter and real-ask integration checks.
    integration)
        exec node src/test/integration/runner.mjs "$@"
        ;;
    shell)
        command -v shellcheck >/dev/null 2>&1 || { echo "shell: shellcheck is not on PATH" >&2; exit 2; }
        shellcheck x install.sh scripts/*.sh .githooks/*
        ;;
    guard) scripts/guard.sh ;;
    # Needs the network for the vulnerability database; CI and releases run it, not pre-commit.
    audit) go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./... ;;
    dev)
        go build -o "${TMPDIR:-/tmp}/ask-dev" .
        exec "${TMPDIR:-/tmp}/ask-dev" "$@"
        ;;
    hooks)
        git config core.hooksPath .githooks
        printf 'git hooks installed: pre-commit runs gofmt and go vet.\n'
        ;;
    *) invalid ;;
esac
