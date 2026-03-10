#!/usr/bin/env bash
# =============================================================================
# sync-polyfills.sh — Copy shared/js/polyfills.js to all app frontend folders
# =============================================================================
# Run this any time shared/js/polyfills.js is updated to ensure every app
# has the latest version.
#
# Usage:  bash scripts/sync-polyfills.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE="$ROOT_DIR/shared/js/polyfills.js"

if [[ ! -f "$SOURCE" ]]; then
  echo "ERROR: Source file not found: $SOURCE"
  exit 1
fi

DESTINATIONS=(
  "$ROOT_DIR/Payroll/Payroll_App/js/polyfills.js"
  "$ROOT_DIR/accounting-ecosystem/frontend-payroll/js/polyfills.js"
  "$ROOT_DIR/accounting-ecosystem/frontend-pos/js/polyfills.js"
  "$ROOT_DIR/accounting-ecosystem/frontend-ecosystem/js/polyfills.js"
  "$ROOT_DIR/accounting-ecosystem/frontend-accounting/js/polyfills.js"
  "$ROOT_DIR/Coaching app/js/polyfills.js"
  "$ROOT_DIR/Point of Sale/POS_App/js/polyfills.js"
)

SOURCE_HASH=$(md5sum "$SOURCE" | awk '{print $1}')
echo "Source: $SOURCE"
echo "MD5:    $SOURCE_HASH"
echo ""

UPDATED=0
SKIPPED=0
MISSING_DIR=0

for DEST in "${DESTINATIONS[@]}"; do
  DEST_DIR="$(dirname "$DEST")"

  if [[ ! -d "$DEST_DIR" ]]; then
    echo "  [SKIP - no dir] $DEST"
    MISSING_DIR=$((MISSING_DIR + 1))
    continue
  fi

  if [[ -f "$DEST" ]]; then
    DEST_HASH=$(md5sum "$DEST" | awk '{print $1}')
    if [[ "$SOURCE_HASH" == "$DEST_HASH" ]]; then
      echo "  [UP TO DATE]   $DEST"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
  fi

  cp "$SOURCE" "$DEST"
  echo "  [UPDATED]      $DEST"
  UPDATED=$((UPDATED + 1))
done

echo ""
echo "Done: $UPDATED updated, $SKIPPED already up to date, $MISSING_DIR skipped (no directory)"
