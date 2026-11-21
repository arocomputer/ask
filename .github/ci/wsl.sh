#!/bin/bash
# Bootstrap a disposable WSL CI distro and test on its Linux filesystem, not the Windows mount.
set -euo pipefail
grep -qi 'microsoft.*WSL2' /proc/sys/kernel/osrelease
apt-get update
apt-get install -y bubblewrap build-essential ca-certificates curl git unzip xz-utils
mkdir -p /opt/ask /opt/node
cp -a . /opt/ask/
cd /opt/node
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
archive=$(awk '$2 ~ /^node-v24\..*-linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
test -n "$archive"
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$archive"
grep "  $archive\$" SHASUMS256.txt | sha256sum --check -
tar -xf "$archive" --strip-components=1
export BUN_INSTALL=/opt/bun
export PATH="/opt/node/bin:$BUN_INSTALL/bin:$PATH"
curl -fsSL https://bun.com/install | bash
useradd --create-home tester
chown -R tester:tester /opt/ask
su tester -s /bin/bash <<'CHECKS'
set -euo pipefail
cd /opt/ask
export PATH="/opt/node/bin:/opt/bun/bin:$PATH"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
bun install --frozen-lockfile
npm run check
node --input-type=module -e 'import { support } from "./src/sandbox/confine.ts"; const s = support(); console.log(s); if (!s.ok) process.exit(1)'
npm test
CHECKS
