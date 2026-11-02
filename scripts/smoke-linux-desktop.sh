#!/usr/bin/env bash
set -euo pipefail

package_directory="${1:?Pass the unpacked Linux application directory as argument 1.}"
state_directory="${2:?Pass the smoke-test state directory as argument 2.}"
app="$package_directory/rel-ai-mcp"
sandbox_helper="$package_directory/chrome-sandbox"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$state_directory"
test -x "$app"
sudo chown root:root "$sandbox_helper"
sudo chmod 4755 "$sandbox_helper"
test "$(stat -c '%u:%g:%a' "$sandbox_helper")" = '0:0:4755'

timeout --signal=TERM --kill-after=5s 45s \
  xvfb-run --auto-servernum dbus-run-session -- \
  node "$script_directory/smoke-desktop-lifecycle.mjs" "$app" "$state_directory"
