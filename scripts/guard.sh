#!/bin/sh
# guard: the rules AGENTS.md states, checked on every change. Each check pins one invariant; a
# change that moves a rule must move this script in the same diff, where review can see it.
set -eu
cd "$(dirname "$0")/.."
fail=0

bad() { printf 'guard: FAIL: %s\n' "$1" >&2; fail=1; }

# Production Go sources only.
prod_go() { find cmd internal packages docs -name '*.go' -not -name '*_test.go'; }

# 1. Terminal dependencies stay in presentation packages; execution stays standard-library only.
if prod_go | xargs grep -nE '^[[:space:]]*(import[[:space:]]+|[[:alnum:]_]+[[:space:]]+)?"[[:alnum:]_.-]+\.[[:alnum:]_.-]+/' \
    | grep -vE 'internal/(tui|status)/|"github.com/arocomputer/ask/' | grep .; then
    bad "external Go dependency outside terminal presentation packages"
fi

# 2. ask knows no particular agent. Only setup, which offers the official ones on a first run,
#    may name them as values; anywhere else they appear in examples and prose only.
agents=
for dir in packages/*/agents; do
    name=${dir%/agents}; name=${name##*/}
    # "continue" is also an existing task field; grep cannot distinguish that from the harness.
    [ "$name" = continue ] && continue
    agents=${agents:+$agents|}$name
done
if grep -rnE --include='*.go' --exclude='*_test.go' --exclude-dir=setup "[{(,=] *\"($agents)\"" internal \
    | grep -v '`' | grep .; then
    bad "an official agent's name is used as a value outside internal/setup"
fi

# 3. home (paths and records), tui (prompts) and update (releases) are leaves: everything may
#    build on them, and they build on nothing of ask's (docs/contributing/architecture.md).
for leaf in home tui update; do
    if grep -l '"github.com/arocomputer/ask/internal/' "internal/$leaf"/*.go | grep .; then
        bad "internal/$leaf imports another ask package"
    fi
done

# 4. Every package says what it is for (a main package as // Command), for go doc and the code map.
for dir in $(prod_go | xargs -n1 dirname | sort -u); do
    grep -lqE '^// (Package|Command) ' "$dir"/*.go || bad "$dir has no // Package doc comment"
done

# 5. The official agents use only Node.js built-ins, like any agent someone could write.
if grep -rhoE "(from|import\() *'[^'.][^']*'" packages/*/lib | grep -v "'node:" | grep .; then
    bad "an official agent imports something other than a node: built-in or its own file"
fi

exit "$fail"
