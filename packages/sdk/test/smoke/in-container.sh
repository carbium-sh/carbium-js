#!/bin/sh
# Runs inside a plain node image: installs the packed tarball, lists it, runs the README's first code block (the quick
# start) as ESM, requires the CJS build, imports every subpath. CARBIUM_KEY may be unset: then the quick start must
# print the 401 refusal and no key.
set -eu
cd "$(mktemp -d)"
echo "node $(node -v) npm $(npm -v)"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error /pkg/*.tgz
npm ls --all >/dev/null
echo "--- tarball contents"
tar -tzf /pkg/*.tgz | sort > files.txt
cat files.txt
if grep -vE '^package/(dist/|README\.md$|LICENSE$|package\.json$)' files.txt; then echo "unexpected file in the tarball"; exit 1; fi
echo "--- quick start from the packed README"
awk '/^```js$/{f=1;next} /^```$/{if(f){exit}} f' node_modules/@carbium/sdk/README.md > quickstart.mjs
test -s quickstart.mjs
cat quickstart.mjs
out=$(node quickstart.mjs 2>&1) || { echo "$out"; echo "quick start exited non-zero"; exit 1; }
echo "$out"
if [ -n "${CARBIUM_KEY:-}" ]; then
  echo "$out" | grep -q '^blockhash ' || { echo "with a key the quick start must print the blockhash"; exit 1; }
  echo "$out" | grep -q "$CARBIUM_KEY" && { echo "the key leaked into the output"; exit 1; }
else
  echo "$out" | grep -qE '^auth 401 -32001 ' || { echo "keyless, the quick start must print the 401 refusal"; exit 1; }
fi
echo "--- cjs and subpaths"
node -e "const s=require('@carbium/sdk'); if (typeof s.createCarbium!=='function'||typeof s.isCarbiumError!=='function') process.exit(1); console.log('cjs ok', Object.keys(s).length, 'exports')"
node --input-type=module -e "
const m = await import('@carbium/sdk'); const w = await import('@carbium/sdk/webhooks'); const a = await import('@carbium/sdk/account'); const d = await import('@carbium/sdk/dca'); const t = await import('@carbium/sdk/tokens'); const st = await import('@carbium/sdk/stream')
for (const [n, ok] of [['createCarbium', typeof m.createCarbium], ['verifyWebhook', typeof w.verifyWebhook], ['CarbiumAccount', typeof a.CarbiumAccount], ['CarbiumDca', typeof d.CarbiumDca], ['CarbiumTokens', typeof t.CarbiumTokens], ['CarbiumStream', typeof st.CarbiumStream]]) if (ok !== 'function') { console.log('missing', n); process.exit(1) }
try { await st.CarbiumStream.connect({ apiKey: 'c_serv_' + 'smoke0000000000' }); process.exit(1) } catch (e) { if (e.kind !== 'stream') { console.log('stream without the peer should fail with kind stream, got', e.kind, e.message); process.exit(1) } }
console.log('esm subpaths ok; stream without the peer package fails with a clear error')
"
if [ ! -e /etc/ssl/certs/ca-certificates.crt ]; then
  echo "--- Carbon Stream without CA certificates, then with SSL_CERT_FILE"
  test -f /ca.crt || { echo "mount a CA bundle at /ca.crt"; exit 1; }
  npm install --no-audit --no-fund --loglevel=error @triton-one/yellowstone-grpc@10
  cat > tls.mjs <<'JS'
const { CarbiumStream } = await import('@carbium/sdk/stream')
const key = process.env.CARBIUM_KEY
try {
  const s = await CarbiumStream.connect(key ? { apiKey: key } : { apiKey: 'c_serv_' + 'PLANTEDSMOKE0000000000', endpoint: 'https://127.0.0.1:9' })
  console.log('slot', (await s.getSlot()).slot)
} catch (e) { console.log('error', e.kind, e.reason, 'retryable', e.retryable, e.message) }
JS
  for ca in '' /ca.crt; do
    out=$(env ${ca:+SSL_CERT_FILE=$ca} node tls.mjs 2>&1)
    echo "${ca:-no CA}: $out"
    case "$out" in *PLANTEDSMOKE*) echo "the key leaked"; exit 1 ;; esac
    if [ -n "${CARBIUM_KEY:-}" ] && echo "$out" | grep -qF -- "$CARBIUM_KEY"; then echo "the key leaked"; exit 1; fi
    if [ -z "$ca" ]; then
      echo "$out" | grep -q '^error stream TLS_ROOTS retryable false .*ca-certificates.*SSL_CERT_FILE' || { echo "without CA certificates the stream must stop and name the fix"; exit 1; }
    elif [ -n "${CARBIUM_KEY:-}" ]; then
      echo "$out" | grep -qE '^slot [0-9]+$' || { echo "with SSL_CERT_FILE the keyed getSlot must answer a slot"; exit 1; }
    else
      echo "$out" | grep -q '^error stream' && ! echo "$out" | grep -q TLS_ROOTS || { echo "with SSL_CERT_FILE the TLS setup must pass and only the closed port refuse"; exit 1; }
    fi
  done
fi
echo "smoke ok on node $(node -v)"
