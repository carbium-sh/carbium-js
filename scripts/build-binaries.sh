#!/bin/sh
# Builds the standalone carbium binaries with Bun's compile from the built CLI (run pnpm build first), into <out>, with
# SHA256SUMS beside them. The gRPC client stays out (--external), so Carbon Stream needs the npm package; the binaries
# never read a .env or bunfig.toml from the folder they run in.
# Usage: scripts/build-binaries.sh <out> [target ...]   (default: all eight targets)
set -eu
out=${1:?usage: scripts/build-binaries.sh <out> [target ...]}
shift
[ "$#" -gt 0 ] || set -- linux-x64 linux-x64-musl linux-arm64 linux-arm64-musl darwin-x64 darwin-arm64 windows-x64 windows-arm64
entry=$(cd "$(dirname "$0")/.." && pwd)/packages/cli/dist/bin.mjs
[ -f "$entry" ] || { echo "build-binaries: $entry is missing; run pnpm build first" >&2; exit 1; }
mkdir -p "$out"
cd "$out"
for t in "$@"; do
  case $t in windows-*) name=carbium-$t.exe ;; *) name=carbium-$t ;; esac
  bun build "$entry" --compile --minify --target="bun-$t" --external @triton-one/yellowstone-grpc \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile "$name"
done
sha256sum carbium-* > SHA256SUMS
