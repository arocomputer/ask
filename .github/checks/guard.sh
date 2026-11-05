#!/bin/sh
# guard: the rules AGENTS.md states, checked on every change. Each check pins one invariant; a
# change that moves a rule must move this script in the same diff, where review can see it.
set -eu
cd "$(dirname "$0")/../.."
fail=0

bad() { printf 'guard: FAIL: %s\n' "$1" >&2; fail=1; }

# Production Go sources only.
prod_go() {
    printf '%s\n' main.go
    find internal -path internal/test -prune -o -name '*.go' -not -name '*_test.go' -print
    find extensions -name '*.go' -not -name '*_test.go'
}

# 1. ask has no Go dependencies: the standard library and its own packages only.
if prod_go | xargs grep -nE '^[[:space:]]*(import[[:space:]]+|[[:alnum:]_]+[[:space:]]+)?"[[:alnum:]_.-]+\.[[:alnum:]_.-]+/' \
    | grep -v '"github.com/arocomputer/ask/' | grep .; then
    bad "external Go dependency"
fi
if grep -qE '^require' go.mod; then
    bad "go.mod lists a dependency"
fi

# 2. ask knows no particular coding agent. Only setup, which offers the built-in extensions for
#    the CLIs it finds, may name them as values; anywhere else they appear in examples and prose.
names=
for dir in extensions/*/; do
    name=${dir%/}; name=${name##*/}
    [ "$name" = test ] && continue
    names=${names:+$names|}$name
done
if grep -rnE --include='*.go' --exclude='*_test.go' --exclude-dir=test "[{(,=] *\"($names)\"" main.go internal \
    | grep -v 'internal/cmd/setup/setup.go' | grep -v '`' | grep .; then
    bad "a built-in extension's name is used as a value outside internal/cmd/setup/setup.go"
fi

# 3. config (paths, config, credentials) and provider (model APIs) are leaves: everything may
#    build on them, and they build on nothing of ask's (docs/contributing/architecture.md).
for leaf in config provider; do
    if grep -l '"github.com/arocomputer/ask/' "internal/$leaf"/*.go | grep .; then
        bad "internal/$leaf imports another ask package"
    fi
done

# 4. Commands share code through cmdutil, never each other; worker is the one exception, which
#    run and continue use to launch. root may import them all.
if grep -rn '"github.com/arocomputer/ask/internal/cmd/' internal/cmd --include='*.go' \
    | grep -v '^internal/cmd/root/' | grep -v '/internal/cmd/worker"' | grep .; then
    bad "a command imports another command"
fi

# 5. Every package says what it is for (a main package as // Command), for go doc and the code map.
for dir in $(prod_go | xargs -n1 dirname | sort -u); do
    grep -lqE '^// (Package|Command) ' "$dir"/*.go || bad "$dir has no // Package doc comment"
done

# 6. The built-in extensions use only Node.js built-ins, like any extension someone could write,
#    and keep identical copies of the activity writer, since neither may import the other.
if grep -rhoE "(from|import\() *'[^'.][^']*'" extensions/*/*.mjs | grep -v "'node:" | grep .; then
    bad "an extension imports something other than a node: built-in or its own file"
fi
cmp -s extensions/claude/writer.mjs extensions/codex/writer.mjs || bad "extensions/*/writer.mjs copies differ"

# 7. Every built-in extension has a manifest, and the binary embeds it.
for name in $(printf '%s' "$names" | tr '|' ' '); do
    [ -f "extensions/$name/extension.json" ] || bad "extensions/$name has no extension.json"
    grep -q "$name/extension.json" extensions/extensions.go || bad "extensions/extensions.go does not embed $name"
done

exit "$fail"
