#!/usr/bin/env bash
# Builds the PM4 spike, wraps it in a minimal app bundle with an identifier, signs it
# ad-hoc (or with APPLE_SIGNING_IDENTITY) and runs it from inside the bundle, which is what
# UNUserNotificationCenter requires. On Linux it just builds and runs the binary.
#   bash spikes/09-unix/pm4-notify/make-app.sh
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release -j "${CARGO_BUILD_JOBS:-4}" 2>&1 | tail -2
bin=target/release/pm4-notify
if [ "$(uname)" != "Darwin" ]; then
  exec "$bin"
fi
app=target/PM4.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/pm4-notify"
cat > "$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.cophyla.pm4</string>
  <key>CFBundleName</key><string>Cophyla PM4</string>
  <key>CFBundleExecutable</key><string>pm4-notify</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
EOF
codesign --force --deep --sign "${APPLE_SIGNING_IDENTITY:--}" "$app"
codesign -dv "$app" 2>&1 | grep -E "Identifier|Signature" | head -3
echo "running from the bundle (the permission prompt names 'Cophyla PM4' the first time)…"
"$app/Contents/MacOS/pm4-notify"
