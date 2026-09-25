#!/usr/bin/env bash
# PM3 (U7): do Bun-built binaries run under the hardened runtime with the platform's
# entitlements? Signs a copy of this Bun and a copy of the compiled brain (built if absent)
# with `codesign --options runtime --entitlements apps/installer/entitlements.plist`, ad-hoc
# unless APPLE_SIGNING_IDENTITY is set, and runs both: Bun prints its version, the brain
# answers `hello` through the fake host handshake the brain-link test uses.
#   bash spikes/09-unix/pm3-sign.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d /tmp/cophyla-pm3.XXXX)
identity=${APPLE_SIGNING_IDENTITY:--}
ent=apps/installer/entitlements.plist

cp "$(which bun)" "$work/bun"
codesign --force --options runtime --entitlements "$ent" --sign "$identity" "$work/bun" && echo "bun signed ($identity)"
codesign -dv --entitlements - "$work/bun" 2>&1 | grep -E "Identifier|flags|allow-jit|runtime" | head -6
"$work/bun" --version && echo "PM3 bun: OK" || echo "PM3 bun: FAIL"
"$work/bun" -e 'console.log("jit ok", [1,2,3].map(x=>x*2).join(","))'

if [ -d brain ]; then
  [ -f brain/dist/brain ] || (cd brain && bun install >/dev/null && bun run build)
  cp brain/dist/brain "$work/brain"
  codesign --force --options runtime --entitlements "$ent" --sign "$identity" "$work/brain" && echo "brain signed ($identity)"
  # brain-link's handshake: one `hello` request on stdin, the answer on stdout.
  printf '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocolVersion":1,"platformVersion":"0.0.0","nodeId":"node_pm3","role":"primary"}}\n' | timeout 15 "$work/brain" 2>/dev/null | head -c 400; echo
  echo "(a line with brainVersion above means PM3 brain: OK)"
else
  echo "no brain repository at ./brain: PM3 brain skipped"
fi
rm -rf "$work"
