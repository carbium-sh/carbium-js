#!/bin/sh
# Inside a plain node or bun image: install the packed CLI with the packed SDK beside it (the SDK is not on npm yet), run
# the README quick start's keyless lines, a keyed or keyless test, and check that no key ever prints. Under bun the CLI
# runs as bun node_modules/carbium/dist/bin.mjs.
set -eu
cd "$(mktemp -d)"
if command -v bun >/dev/null 2>&1; then
  RT="bun $(bun --version)"
  # the CLI's @carbium/sdk dependency resolves to the packed SDK, not the registry
  printf '{"name":"smoke","private":true,"overrides":{"@carbium/sdk":"file:%s"}}\n' /pkg/carbium-sdk-*.tgz >package.json
  bun add /pkg/carbium-sdk-*.tgz /pkg/carbium-0.1.1.tgz
  CLI="bun $PWD/node_modules/carbium/dist/bin.mjs"
  JS=bun
else
  RT="node $(node -v) npm $(npm -v)"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --loglevel=error /pkg/*.tgz
  CLI="$PWD/node_modules/.bin/carbium"
  JS=node
fi
echo "$RT"
export HOME="$PWD/home" XDG_CONFIG_HOME="$PWD/home/cfg"
mkdir -p "$HOME"
echo "--- tarball contents"
tar -tzf /pkg/carbium-0.1.1.tgz | sort | tee files.txt | head -20
if grep -vE '^package/(dist/|README\.md$|LICENSE$|package\.json$)' files.txt; then echo "unexpected file in the tarball"; exit 1; fi
test "$($CLI --version)" = "0.1.1"
echo "--- README quick start, the keyless lines, against the live hosts"
$CLI tokens lookup So11111111111111111111111111111111111111112 | head -4
$CLI plans --json | head -c 120; echo
$CLI dca health | head -2
$CLI rpc list --json | $JS -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const l=JSON.parse(s);if(l.length!==53||l.some(m=>m.method==='sendTransaction'))process.exit(1);console.log('rpc list',l.length)})"
echo "--- flags before the command and the no- flags parse the same on every runtime"
$CLI --json --no-input tokens search sol --no-token22 --limit 1 | head -c 120; echo
echo "--- test against services.carbium.sh"
if [ -n "${CARBIUM_KEY:-}" ]; then
  out=$($CLI test 2>&1) || { echo "$out"; echo "carbium test failed with a key"; exit 1; }
  echo "$out" | grep -q getLatestBlockhash || exit 1
  echo "$out" | grep -q "$CARBIUM_KEY" && { echo "the key leaked"; exit 1; }
else
  set +e; out=$($CLI test 2>&1); code=$?; set -e
  echo "$out"
  [ "$code" -eq 3 ] || { echo "keyless carbium test must exit 3 (no key), got $code"; exit 1; }
  echo "--- a planted key in the environment never prints (sent to a closed local port, never to services.carbium.sh)"
  planted="c_serv_"; planted="${planted}PLANTEDSMOKE0000000000"
  set +e; out=$(env CARBIUM_KEY="$planted" $CLI test --endpoint http://127.0.0.1:9 2>&1); code=$?; set -e
  echo "$out"
  [ "$code" -eq 1 ] || { echo "a planted key against a closed port must end as a service error, exit 1, got $code"; exit 1; }
  echo "$out" | grep -q PLANTEDSMOKE && { echo "the key leaked"; exit 1; }
fi
if [ ! -e /etc/ssl/certs/ca-certificates.crt ]; then
  echo "--- carbium stream slot without CA certificates, then with SSL_CERT_FILE"
  test -f /ca.crt || { echo "mount a CA bundle at /ca.crt"; exit 1; }
  npm install --no-audit --no-fund --loglevel=error @triton-one/yellowstone-grpc@10
  if [ -n "${CARBIUM_KEY:-}" ]; then key="$CARBIUM_KEY" url=""; else key="c_serv_"; key="${key}PLANTEDSMOKE0000000000" url="--stream-url https://127.0.0.1:9"; fi
  for ca in '' /ca.crt; do
    set +e; out=$(env CARBIUM_KEY="$key" ${ca:+SSL_CERT_FILE=$ca} $CLI stream slot $url 2>&1); code=$?; set -e
    echo "${ca:-no CA}: exit $code"; echo "$out"
    if echo "$out" | grep -qF -- "$key"; then echo "the key leaked"; exit 1; fi
    if [ -z "$ca" ]; then
      [ "$code" -eq 2 ] && echo "$out" | grep -q 'stream error TLS_ROOTS: .*ca-certificates.*SSL_CERT_FILE' && echo "$out" | grep -q 'retryable: no' || { echo "without CA certificates carbium stream slot must stop and name the fix"; exit 1; }
    elif [ -n "${CARBIUM_KEY:-}" ]; then
      [ "$code" -eq 0 ] && echo "$out" | grep -qE '^slot: [0-9]+$' || { echo "with SSL_CERT_FILE carbium stream slot must answer a slot"; exit 1; }
    else
      [ "$code" -ne 0 ] && ! echo "$out" | grep -q TLS_ROOTS || { echo "with SSL_CERT_FILE the TLS setup must pass and only the closed port refuse"; exit 1; }
    fi
  done
fi
$CLI completion bash | head -1
echo "smoke ok on $RT"
