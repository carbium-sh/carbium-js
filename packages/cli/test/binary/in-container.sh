#!/bin/sh
# Inside a clean container (see run.sh): install.sh refuses each planted release, leaves nothing behind and prints no
# control byte, then installs the latest version npm names, as a user's run with no CARBIUM_VERSION does; the installed
# binary prints the version, lists the 53 RPC methods, ignores a .env and a bunfig.toml in its folder, and says Carbon
# Stream needs the npm package.
set -eu
if command -v apk >/dev/null; then apk add --no-cache -q curl >/dev/null; else export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null; fi
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; exit 1; }
base=https://mirror
dest=$HOME/.carbium/bin/carbium
tags() { printf '{"latest-1":"0.0.3","latest":"%s","next":"0.0.1"}\n' "$1" > /tags/dist-tags; } # npm's answer, with decoy keys
refuse() { # version ('' = the latest on npm), base, label, text the refusal must hold, install root (default: ~/.carbium)
  if out=$(CARBIUM_INSTALL=${5:-} CARBIUM_DOWNLOAD_BASE=$2 CARBIUM_VERSION=$1 sh /install.sh 2>&1); then bad "$3: it installed"; fi
  if printf '%s\n' "$out" | LC_ALL=C grep -q '[^ -~]'; then bad "$3: its output holds a control byte: $(printf '%s' "$out" | od -c | head -n 3)"; fi
  printf '%s' "$out" | grep -qF "$4" || bad "$3: it said: $out"
  [ ! -e "$HOME/.carbium" ] || bad "$3: it left $(find "$HOME/.carbium" | tr '\n' ' ')"
  ok "$3: refused ($(printf '%s\n' "$out" | tail -n 1))"
}
if command -v apk >/dev/null; then
  refuse "$VERSION" "$base" "musl without libstdc++" "does not run here"
  apk add --no-cache -q libstdc++ libgcc >/dev/null
fi
refuse 0.0.1 "$base" "a wrong checksum" "checksum mismatch"
refuse 0.0.2 "$base" "no SHA256SUMS line for the asset" "no single valid line"
refuse 0.0.3 "$base" "a binary reporting another version" "reports '$VERSION', not 0.0.3"
refuse "$VERSION" "http://mirror" "an http mirror" "must be an https:// URL"
tags 0.0.9
refuse "" "$base" "a latest version the mirror does not hold" "cannot download $base/cli-v0.0.9/SHA256SUMS"
printf '{"latest":"0.0.1\033]0;x\007\033[2J\302\233\r"}\n' > /tags/dist-tags
refuse "" "$base" "a latest version holding terminal escapes" "not a version"
mkdir -p /opt/keep/bin && echo kept > /opt/keep/note
if CARBIUM_INSTALL=/opt/keep CARBIUM_DOWNLOAD_BASE=$base CARBIUM_VERSION=0.0.2 sh /install.sh 2>/dev/null; then bad "folders that were there before: it installed"; fi
[ "$(find /opt/keep | sort | tr '\n' ' ')" = "/opt/keep /opt/keep/bin /opt/keep/note " ] || bad "a refused install changed folders that were there before: $(find /opt/keep | tr '\n' ' ')"
ok "a refused install leaves an empty folder and a file that were there before"
mkdir -p /opt/tools
refuse 0.0.2 "$base" "an install root holding .." "must not contain .." /opt/new/../tools
[ "$(find /opt/tools /opt/new 2>/dev/null | tr '\n' ' ')" = "/opt/tools " ] || bad "an install root holding ..: it left $(find /opt/tools /opt/new 2>/dev/null | tr '\n' ' ')"

CARBIUM_INSTALL='/opt/back\slash' CARBIUM_DOWNLOAD_BASE=$base CARBIUM_VERSION=$VERSION sh /install.sh 2>/tmp/install.log || { cat /tmp/install.log; bad "install into a folder whose name holds a backslash"; }
[ "$('/opt/back\slash/bin/carbium' --version)" = "$VERSION" ] || bad "a folder whose name holds a backslash: --version"
ok "installed into a folder whose name holds a backslash"

tags "$VERSION"
CARBIUM_DOWNLOAD_BASE=$base sh /install.sh 2>/tmp/install.log || { cat /tmp/install.log; bad "install with no CARBIUM_VERSION"; }
[ "$("$dest" --version)" = "$VERSION" ] || bad "--version"
[ "$(find "$HOME/.carbium" | sort | tr '\n' ' ')" = "$HOME/.carbium $HOME/.carbium/bin $dest " ] || bad "the install left $(find "$HOME/.carbium" | tr '\n' ' ')"
ok "installed the latest on npm, $(sed -n 's/.*(\(carbium-[a-z0-9-]*\)).*/\1/p' /tmp/install.log); --version $VERSION"
n=$("$dest" rpc list --json | grep -c '"method"')
[ "$n" = 53 ] || bad "rpc list: $n methods"
ok "rpc list: 53 methods"

mkdir -p /tmp/w && cd /tmp/w
printf 'CARBIUM_KEY=c_serv_%s\n' PLANTEDDOTENV0000000000 > .env
printf 'preload = ["./pre.js"]\n' > bunfig.toml
echo 'console.log("PRELOAD RAN")' > pre.js
set +e
out=$("$dest" test --endpoint http://127.0.0.1:9 2>&1)
code=$?
set -e
[ "$code" = 3 ] || bad "a .env in the folder was read: exit $code: $out"
if printf '%s' "$out" | grep -q 'PRELOAD RAN'; then bad "a bunfig.toml preload ran"; fi
ok ".env and bunfig.toml in the folder are ignored (exit 3, no service key)"
key=c_serv_
key=${key}PLANTEDSTREAM0000000000
set +e
out=$(CARBIUM_KEY=$key "$dest" stream slot --stream-url http://127.0.0.1:9 2>&1)
code=$?
set -e
[ "$code" = 2 ] || bad "stream slot: exit $code: $out"
printf '%s' "$out" | grep -qF 'npm install -g carbium' || bad "stream slot said: $out"
if printf '%s' "$out" | grep -q PLANTEDSTREAM; then bad "stream slot printed the key"; fi
ok "stream slot: exit 2, Carbon Stream needs the npm package"
echo "proof ok on $(uname -m)"
