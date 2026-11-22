#!/usr/bin/env bash
# Proves the standalone binaries and install.sh in clean containers. A local HTTPS mirror serves cli-v releases laid out
# as on GitHub (install.sh's CARBIUM_DOWNLOAD_BASE mirror setting points at it): the version as built, and three planted
# releases install.sh must refuse: a wrong checksum, no SHA256SUMS line for the asset, a binary reporting another version.
# The mirror also answers as registry.npmjs.org on the proof's own network, with the dist-tags file the proof writes, so the
# run with no CARBIUM_VERSION is proven and nothing leaves that network.
# Usage: run.sh <dir holding the binaries and SHA256SUMS> [platform=image ...]
set -euo pipefail
bins=$(cd "${1:?usage: run.sh <binaries dir> [platform=image ...]}" && pwd)
shift
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
version=$(node -p "require('$root/packages/cli/package.json').version")
targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(linux/amd64=debian:trixie-slim linux/amd64=alpine:3 linux/arm64=debian:trixie-slim linux/arm64=alpine:3)
work=$(mktemp -d "$bins/../carbium-binary-proof.XXXXXX") # beside the binaries, so the mirror can hard-link them
net=carbium-binary-proof-$$
# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() { docker rm -f "$net-mirror" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

m=$work/srv
mkdir -p "$m/cli-v$version" "$m/cli-v0.0.1" "$m/cli-v0.0.2" "$m/cli-v0.0.3" "$work/pki" "$work/tags"
cp -l "$bins"/carbium-* "$bins/SHA256SUMS" "$m/cli-v$version/"
cp -l "$bins"/carbium-* "$m/cli-v0.0.1/"
awk '{ c = substr($1, 1, 1); print (c == "0" ? "1" : "0") substr($1, 2) "  " $2 }' "$bins/SHA256SUMS" > "$m/cli-v0.0.1/SHA256SUMS"
cp -l "$bins"/carbium-* "$m/cli-v0.0.2/"
printf '%064d  carbium-other\n' 0 > "$m/cli-v0.0.2/SHA256SUMS"
cp -l "$bins"/carbium-* "$bins/SHA256SUMS" "$m/cli-v0.0.3/"
chmod -R a+rX "$work"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=mirror -addext subjectAltName=DNS:mirror,DNS:registry.npmjs.org \
  -keyout "$work/pki/key.pem" -out "$work/pki/ca.pem" 2>/dev/null
chmod a+r "$work/pki/key.pem"
printf 'events {}\nhttp { server { listen 443 ssl; server_name mirror registry.npmjs.org; ssl_certificate /pki/ca.pem; ssl_certificate_key /pki/key.pem; root /srv; location = /-/package/carbium/dist-tags { alias /tags/dist-tags; } } }\n' > "$work/nginx.conf"
docker network create "$net" >/dev/null
docker run -d --name "$net-mirror" --network "$net" --network-alias mirror --network-alias registry.npmjs.org --memory=256m --cpus=1 --pids-limit=64 \
  -v "$m:/srv:ro" -v "$work/pki:/pki:ro" -v "$work/tags:/tags:ro" -v "$work/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:alpine >/dev/null

status=0
for t in "${targets[@]}"; do
  platform=${t%%=*} image=${t#*=}
  echo "=== $image ($platform)"
  if nice -n 19 docker run --rm --platform "$platform" --network "$net" --memory=2g --cpus=2 --pids-limit=256 -e VERSION="$version" \
    -e CURL_CA_BUNDLE=/pki/ca.pem -v "$work/pki/ca.pem:/pki/ca.pem:ro" -v "$work/tags:/tags" -v "$here/in-container.sh:/proof.sh:ro" \
    -v "$root/packages/cli/install.sh:/install.sh:ro" "$image" sh /proof.sh; then
    echo "=== $image ($platform) PASS"
  else
    echo "=== $image ($platform) FAIL"; status=1
  fi
done
exit $status
