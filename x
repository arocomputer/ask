#!/bin/sh
# The one entry point for checks, builds and releases. ./x alone runs every offline check, as
# CI does; each step prints a header and its time, and the first failure stops the run.
set -eu
cd "$(dirname "$0")"

usage() {
    cat <<'EOF'
usage: ./x [command] [args...]
  check              Default: tools, format, vet, Go tests, baymax, shell, workflows, formula, guard
  fmt [--check]      Format Go sources, or check without writing
  lint               go vet
  test [args...]     go test (default: ./...); for example ./x test ./internal/test -run TestRuns
  build [args...]    go build (default: ./...)
  baymax [name...]   The built-in extensions' tests against fake CLIs: claude, codex or both
  shell | guard      shellcheck, or the architectural guards in .github/checks
  workflows          actionlint on .github/workflows
  audit              govulncheck; needs the network, so it is not part of check
  tools              Say which of the tools the checks need are missing
  install [dir]      Build ask from this checkout into DIR (default ~/.local/bin)
  dev [args...]      Build ask from this checkout and run it
  release vX.Y.Z     Prepare a changelog PR, then dispatch a checked main release
  hooks              Install the git hooks: gofmt and vet before each commit
  help               This text
EOF
}

invalid() { usage >&2; exit 2; }

# step NAME COMMAND...: a header, the command, and how long it took; exits on failure.
step() {
    name=$1; shift
    start=$(date +%s)
    printf '\033[1m==> %s\033[0m\n' "$name"
    "$@" || { printf '\033[1;31m==> %s failed\033[0m\n' "$name" >&2; exit 1; }
    printf '    %ss\n' "$(( $(date +%s) - start ))"
}

# need TOOL HINT...: fail with an install hint when TOOL is not on PATH.
need() {
    command -v "$1" >/dev/null 2>&1 && return 0
    printf '%s is not on PATH; %s\n' "$1" "$2" >&2
    return 1
}

command=${1-check}
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
    check|lint|shell|guard|workflows|audit|hooks|tools) [ "$#" -eq 0 ] || invalid ;;
    fmt) [ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = "--check" ]; } || invalid ;;
    help|--help|-h) [ "$#" -eq 0 ] || invalid; usage; exit 0 ;;
esac

case "$command" in
    check)
        ./x tools
        step format ./x fmt --check
        step vet ./x lint
        step test ./x test
        step baymax ./x baymax
        step shell ./x shell
        step workflows ./x workflows
        step formula ruby -c ask.rb
        step guard ./x guard
        printf '\033[1;32m==> all checks passed\033[0m\n'
        ;;
    tools)
        missing=0
        need go 'install Go 1.26 or newer from https://go.dev/dl' || missing=1
        need node 'install Node.js 18 or newer for the harness tests' || missing=1
        need shellcheck 'brew install shellcheck, or apt install shellcheck' || missing=1
        need actionlint 'go install github.com/rhysd/actionlint/cmd/actionlint@latest' || missing=1
        need ruby 'ruby checks the Homebrew formula; macOS ships it, else apt install ruby' || missing=1
        exit "$missing"
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
    baymax)
        if [ "$#" -eq 0 ]; then set -- claude codex; fi
        files=
        for name in "$@"; do
            [ -d "extensions/$name/test" ] || { printf 'baymax: no built-in extension named %s\n' "$name" >&2; exit 2; }
            files="$files extensions/$name/test/*.test.*"
        done
        # shellcheck disable=SC2086 # one test file per word
        exec node --test $files
        ;;
    shell)
        need shellcheck 'brew install shellcheck, or apt install shellcheck'
        shellcheck x install.sh .github/release/*.sh .github/checks/*.sh .githooks/* extensions/claude/claude extensions/codex/codex
        ;;
    guard) .github/checks/guard.sh ;;
    workflows)
        need actionlint 'go install github.com/rhysd/actionlint/cmd/actionlint@latest'
        actionlint .github/workflows/*.yml
        ;;
    audit) go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./... ;;
    install)
        dir=${1:-$HOME/.local/bin}
        mkdir -p "$dir"
        go build -o "$dir/ask" .
        printf 'installed %s/ask (%s)\n' "$dir" "$("$dir/ask" --version)"
        ;;
    dev)
        go build -o "${TMPDIR:-/tmp}/ask-dev" .
        exec "${TMPDIR:-/tmp}/ask-dev" "$@"
        ;;
    release) exec .github/release/release.sh "$@" ;;
    hooks)
        git config core.hooksPath .githooks
        printf 'git hooks installed: pre-commit runs gofmt and go vet.\n'
        ;;
    *) invalid ;;
esac
