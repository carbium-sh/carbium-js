#!/usr/bin/env bash
# Packs the SDK and this package, installs both in node:22-alpine and node:24-alpine, runs the quick start.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
rm -rf .pack && mkdir -p .pack
pnpm --filter @carbium/sdk build >/dev/null
pnpm --filter @carbium/mcp build >/dev/null
(cd packages/sdk && pnpm pack --pack-destination ../../.pack >/dev/null)
(cd packages/mcp && pnpm pack --pack-destination ../../.pack >/dev/null)
ls -la .pack
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(node:22-alpine node:24-alpine)
status=0
for img in "${images[@]}"; do
  echo "=== $img"
  if nice -n 19 docker run --rm --memory=2g --cpus=2 --pids-limit=256 ${CARBIUM_KEY:+-e CARBIUM_KEY} -v "$PWD/.pack:/pkg:ro" -v "$PWD/packages/mcp/test/smoke:/smoke:ro" "$img" sh /smoke/in-container.sh; then
    echo "=== $img PASS"
  else
    echo "=== $img FAIL"; status=1
  fi
done
exit $status
