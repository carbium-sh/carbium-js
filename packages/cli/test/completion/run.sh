#!/usr/bin/env bash
# Runs each completion line of the CLI README, and the line each generated script names in its first comment, in its
# own shell in debian:trixie-slim (bash, and zsh and fish from apt), from the built CLI, each in a fresh HOME: every
# line must register the completion, and the same check with no line run must not. Usage: run.sh [README]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
readme=$(realpath "${1:-$root/packages/cli/README.md}")
(cd "$root" && pnpm --filter @carbium/sdk build >/dev/null && pnpm --filter carbium build >/dev/null)
nice -n 19 docker run --rm -i --memory=1g --cpus=2 --pids-limit=256 -e DEBIAN_FRONTEND=noninteractive -v "$root:/w:ro" -v "$readme:/README.md:ro" \
  -v "$(node -p process.execPath):/usr/local/bin/node:ro" debian:trixie-slim bash -s <<'SH'
set -euo pipefail
apt-get update -qq && apt-get install -y -qq --no-install-recommends zsh fish >/dev/null
printf '#!/bin/sh\nexec node /w/packages/cli/dist/bin.mjs "$@"\n' > /usr/local/bin/carbium && chmod +x /usr/local/bin/carbium
block=$(awk '/^## Completion/ { f = 1 } f && /^```sh/ { b = 1; next } b && /^```/ { exit } b' /README.md)
# registered <shell> <line>: runs the line (none when empty) in a fresh HOME, then asks that shell for carbium's completion
registered() {
  HOME=$(mktemp -d)
  export HOME
  case $1 in
    bash) out=$(bash --norc --noprofile -c "$2"$'\n''complete -p carbium' 2>&1 || true); [[ $out == *'complete -F _carbium carbium'* ]] ;;
    zsh) out=$(zsh -f -c "$2"$'\n''print -r -- "comp=${_comps[carbium]-none}"' 2>&1 || true); [[ $out == *'comp=_carbium'* ]] ;;
    fish) out=$({ [ -z "$2" ] || fish -N -c "$2"; fish -c 'complete -C"carbium tok"'; } 2>&1 || true); [[ $'\n'$out == *$'\n'tokens* ]] ;;
  esac
}
status=0
for sh in bash zsh fish; do
  if registered "$sh" ''; then echo "FAIL $sh: the check passes with no line run"; status=1; fi
  for which in README header; do
    if [ "$which" = README ]; then line=$(printf '%s\n' "$block" | grep -F "carbium completion $sh" | head -n 1 || true)
    else line=$(carbium completion "$sh" | sed -n "s/^# $sh completion for carbium: //p"); fi
    if [ -z "$line" ]; then echo "FAIL $sh: the $which gives no line"; status=1
    elif registered "$sh" "$line"; then echo "ok   $sh ($which): $line"
    else printf 'FAIL %s (%s): %s\n  %s\n' "$sh" "$which" "$line" "${out:0:300}"; status=1
    fi
  done
done
exit $status
SH
