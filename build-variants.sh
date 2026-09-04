#!/usr/bin/env bash
# Build the reference-inspired scarf gopher in grounded and cloud-riding modes.
set -euo pipefail
cd "$(dirname "$0")"

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
RENDER=true
[[ "${1:-}" == "--no-render" ]] && RENDER=false
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gopher-variants.XXXXXX")"
cleanup() {
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

build_variant() {
  local variant="$1"
  local stem="$2"
  local tmp_glb="$TMP_DIR/${stem}.glb"
  local tmp_blend="$TMP_DIR/${stem}.blend"
  local tmp_preview="$TMP_DIR/${stem}-preview"
  local log="$TMP_DIR/${stem}.log"

  if [[ "$RENDER" == true ]]; then
    "$BLENDER" -b --python blender/gopher_scarf.py -- \
      --variant "$variant" \
      --out "$tmp_glb" \
      --blend "$tmp_blend" \
      --render "$tmp_preview" >"$log" 2>&1 || true
  else
    "$BLENDER" -b --python blender/gopher_scarf.py -- \
      --variant "$variant" \
      --out "$tmp_glb" \
      --blend "$tmp_blend" >"$log" 2>&1 || true
  fi

  if [[ -s "$tmp_glb" && -s "$tmp_blend" ]]; then
    mv "$tmp_glb" "assets/${stem}.glb"
    mv "$tmp_blend" "blender/${stem}.blend"
    if [[ "$RENDER" == true ]]; then
      local preview
      for preview in "$tmp_preview"-*.png; do
        [[ -e "$preview" ]] || continue
        mv "$preview" "assets/$(basename "$preview")"
      done
    fi
    grep -E "SCARF_GOPHER_|Error|Traceback" "$log" || true
  else
    echo "Blender did not produce ${stem}; using the GLB-only fallback exporter." >&2
    grep -E "Error|Traceback|Writing:.*crash" "$log" || true
    python3 blender/export_scarf_glb.py \
      --variant "$variant" \
      --out "assets/${stem}.glb"
  fi
}

build_variant plain gopher-scarf
build_variant cloud gopher-scarf-cloud

# Inline every assets/*.glb into web/gopher-model.js (the game runs from file://).
python3 tools/embed_models.py
