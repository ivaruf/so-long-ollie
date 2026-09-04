#!/usr/bin/env bash
# Build the reference-inspired scarf gopher in grounded and cloud-riding modes.
set -euo pipefail
cd "$(dirname "$0")"

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
RENDER=true
[[ "${1:-}" == "--no-render" ]] && RENDER=false

build_variant() {
  local variant="$1"
  local stem="$2"
  if [[ "$RENDER" == true ]]; then
    "$BLENDER" -b --python blender/gopher_scarf.py -- \
      --variant "$variant" \
      --out "assets/${stem}.glb" \
      --blend "blender/${stem}.blend" \
      --render "assets/${stem}-preview" \
      | grep -E "SCARF_GOPHER_|Error|Traceback" || true
  else
    "$BLENDER" -b --python blender/gopher_scarf.py -- \
      --variant "$variant" \
      --out "assets/${stem}.glb" \
      --blend "blender/${stem}.blend" \
      | grep -E "SCARF_GOPHER_|Error|Traceback" || true
  fi
}

build_variant plain gopher-scarf
build_variant cloud gopher-scarf-cloud
