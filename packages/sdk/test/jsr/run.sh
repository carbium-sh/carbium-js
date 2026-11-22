#!/usr/bin/env bash
# Proves @carbium/sdk for JSR: jsr publish --dry-run passes on a copy of the package, a planted slow type (an export with
# no declared return type) fails it, and Deno imports all six entry points from the package's own jsr.json exports and
# makes one keyless token lookup. Usage: run.sh [deno image]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$here/../.." && pwd)
deno=${1:-denoland/deno:2.9.8}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
copy() { mkdir -p "$1" && cp -r "$pkg/src" "$pkg/package.json" "$pkg/jsr.json" "$pkg/README.md" "$pkg/LICENSE" "$1/"; }

copy "$work/ok"
(cd "$work/ok" && npx --yes jsr@0.14.3 publish --dry-run) > "$work/ok.log" 2>&1 || { cat "$work/ok.log"; echo "FAIL dry run"; exit 1; }
grep -q 'Dry run complete' "$work/ok.log" || { cat "$work/ok.log"; echo "FAIL dry run said no success"; exit 1; }
echo "ok   jsr publish --dry-run"

copy "$work/slow"
echo 'export function plantedSlow(n: number) { return n + 1 }' >> "$work/slow/src/index.ts"
if (cd "$work/slow" && npx --yes jsr@0.14.3 publish --dry-run) > "$work/slow.log" 2>&1; then echo "FAIL a slow type passed the dry run"; exit 1; fi
grep -q 'missing-explicit-return-type' "$work/slow.log" || { cat "$work/slow.log"; echo "FAIL the slow type was refused for another reason"; exit 1; }
echo "ok   a planted slow type fails the dry run"

mkdir -p "$work/deno/sdk"
cp -r "$pkg/src" "$work/deno/sdk/" && cp "$pkg/jsr.json" "$work/deno/sdk/deno.json"
echo '{ "workspace": ["./sdk"] }' > "$work/deno/deno.json"
cat > "$work/deno/main.ts" <<'TS'
import { createCarbium, VERSION } from '@carbium/sdk'
import { verifyWebhook } from '@carbium/sdk/webhooks'
import { CarbiumAccount } from '@carbium/sdk/account'
import { CarbiumDca } from '@carbium/sdk/dca'
import { CarbiumTokens } from '@carbium/sdk/tokens'
import { CarbiumStream } from '@carbium/sdk/stream'
createCarbium({ apiKey: 'c_serv_' + 'DENO000000000000000000' })
const sol = await new CarbiumTokens().lookup('So11111111111111111111111111111111111111112')
console.log(VERSION, typeof verifyWebhook, typeof CarbiumAccount, typeof CarbiumDca, typeof CarbiumStream, sol?.name)
TS
chmod -R a+rX "$work/deno"
out=$(nice -n 19 docker run --rm --memory=1g --cpus=2 --pids-limit=256 --user "$(id -u):$(id -g)" -e DENO_DIR=/tmp/dd -e NO_COLOR=1 \
  -v "$work/deno:/w:ro" -w /w "$deno" run --no-lock --allow-net --allow-env --allow-read /w/main.ts 2>&1) || { echo "$out"; echo "FAIL deno import"; exit 1; }
version=$(node -p "require('$pkg/package.json').version")
[ "$(printf '%s\n' "$out" | tail -n 1)" = "$version function function function function Wrapped SOL" ] || { echo "$out"; echo "FAIL deno import said this"; exit 1; }
echo "ok   Deno ($deno) imports the six entry points; token lookup: Wrapped SOL"
