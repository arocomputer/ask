#!/bin/sh
# Shared repository commands for local checks, CI and releases.
set -eu
cd "$(dirname "$0")"

usage() {
    cat <<'EOF'
usage: ./x [command] [args...]
  check              Default; formatting, vet, tests, integration, shell, workflows, formula syntax and guards
  fmt [--check]      Format Go sources, or check without writing
  lint               Run go vet
  test [args...]     Forward arguments to go test (default: ./...)
  build [args...]    Forward arguments to go build (default: ./...)
  baymax [names...]  Offline packaged-agent integration checks
  shell | guard      Shellcheck or architectural guards
  workflows          Check GitHub Actions with actionlint
  audit              Network vulnerability audit, separate from check
  release vX.Y.Z     Prepare a changelog PR, then dispatch a checked main release
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
    check|lint|shell|guard|workflows|audit|hooks) [ "$#" -eq 0 ] || invalid ;;
    fmt)
        [ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = "--check" ]; } || invalid
        ;;
    help|--help|-h) [ "$#" -eq 0 ] || invalid; usage; exit 0 ;;
esac

case "$command" in
    # Shared offline checks. CI also checks races and release artifacts; audit needs the network.
    check)
        ./x fmt --check
        ./x lint
        ./x test
        ./x baymax
        ./x shell
        ./x guard
        ./x workflows
        ruby -c ask.rb
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
    baymax|node)
        exec node src/test/baymax/runner.mjs "$@"
        ;;
    shell)
        command -v shellcheck >/dev/null 2>&1 || { echo "shell: shellcheck is not on PATH" >&2; exit 2; }
        shellcheck x install.sh .github/release/*.sh .github/checks/*.sh .githooks/*
        ;;
    guard) .github/checks/guard.sh ;;
    workflows)
        command -v actionlint >/dev/null 2>&1 || { echo "workflows: actionlint is not on PATH" >&2; exit 2; }
        actionlint .github/workflows/*.yml
        ;;
    # Needs the network for the vulnerability database; CI and releases run it, not pre-commit.
    audit) go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./... ;;
    release) exec .github/release/release.sh "$@" ;;
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
