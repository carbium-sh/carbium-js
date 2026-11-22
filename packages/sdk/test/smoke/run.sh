#!/usr/bin/env bash
# Mark 1: the packed package installs clean in fresh node:22-alpine, node:24-alpine and node:24-slim containers and its
# README quick start runs against services.carbium.sh. On node:24-slim (no CA certificates) Carbon Stream must stop and
# name the fix, then answer with SSL_CERT_FILE. Usage: test/smoke/run.sh [image ...]; CARBIUM_KEY is passed through.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf .pack && mkdir -p .pack
pnpm build >/dev/null
pnpm pack --pack-destination .pack >/dev/null
ls -la .pack
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(node:22-alpine node:24-alpine node:24-slim)
status=0
for img in "${images[@]}"; do
  echo "=== $img"
  if nice -n 19 docker run --rm --memory=2g --cpus=2 --pids-limit=256 ${CARBIUM_KEY:+-e CARBIUM_KEY} -v "$PWD/.pack:/pkg:ro" -v "$PWD/test/smoke:/smoke:ro" -v /etc/ssl/certs/ca-certificates.crt:/ca.crt:ro "$img" sh /smoke/in-container.sh; then
    echo "=== $img PASS"
  else
    echo "=== $img FAIL"; status=1
  fi
done
exit $status
