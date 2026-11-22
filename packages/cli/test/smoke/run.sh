#!/usr/bin/env bash
# Packs the SDK and this package, installs both in node:22-alpine, node:24-alpine, node:24-slim and oven/bun:1-alpine, runs
# the quick start. On node:24-slim (no CA certificates) carbium stream slot must stop and name the fix, then answer with
# SSL_CERT_FILE.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
rm -rf .pack && mkdir -p .pack
pnpm --filter @carbium/sdk build >/dev/null
pnpm --filter carbium build >/dev/null
(cd packages/sdk && pnpm pack --pack-destination ../../.pack >/dev/null)
(cd packages/cli && pnpm pack --pack-destination ../../.pack >/dev/null)
ls -la .pack
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(node:22-alpine node:24-alpine node:24-slim oven/bun:1-alpine)
status=0
for img in "${images[@]}"; do
  echo "=== $img"
  if nice -n 19 docker run --rm --memory=2g --cpus=2 --pids-limit=256 ${CARBIUM_KEY:+-e CARBIUM_KEY} -v "$PWD/.pack:/pkg:ro" -v "$PWD/packages/cli/test/smoke:/smoke:ro" -v /etc/ssl/certs/ca-certificates.crt:/ca.crt:ro "$img" sh /smoke/in-container.sh; then
    echo "=== $img PASS"
  else
    echo "=== $img FAIL"; status=1
  fi
done
exit $status
