#!/usr/bin/env bash
# Rebuild the gopher model with Blender and inline it into the web game.
#   ./build.sh            # export GLB + preview renders + web/gopher-model.js
#   ./build.sh --no-render
set -euo pipefail
cd "$(dirname "$0")"

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
RENDER_ARGS=(--render assets/gopher-preview)
[[ "${1:-}" == "--no-render" ]] && RENDER_ARGS=()

"$BLENDER" -b --python blender/gopher.py -- --out assets/gopher.glb ${RENDER_ARGS[@]+"${RENDER_ARGS[@]}"} \
  | grep -E "GOPHER_|Error|Traceback" || true

# Inline every assets/*.glb into web/gopher-model.js (the game runs from file://).
python3 tools/embed_models.py
