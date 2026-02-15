#!/bin/bash
set -euo pipefail

# Vendor OpenClaw source for reference
# This script shallow-clones OpenClaw and places it in vendor/openclaw/

VENDOR_DIR="vendor/openclaw"
REPO_URL="https://github.com/anthropics/openclaw.git"  # Update with actual URL
BRANCH="main"

echo "=== Vendoring OpenClaw ==="

# Create vendor directory
mkdir -p "$(dirname "$VENDOR_DIR")"

# Remove existing vendor
rm -rf "$VENDOR_DIR"

# Shallow clone
if git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$VENDOR_DIR" 2>/dev/null; then
  # Remove .git to keep it as plain files
  rm -rf "$VENDOR_DIR/.git"
  echo "✓ Vendored OpenClaw from $REPO_URL"
else
  echo "⚠ Could not clone OpenClaw. Creating placeholder."
  mkdir -p "$VENDOR_DIR"
  echo "# OpenClaw Vendor" > "$VENDOR_DIR/README.md"
  echo "Update REPO_URL in scripts/vendor-openclaw.sh with the correct OpenClaw repository URL." >> "$VENDOR_DIR/README.md"
fi

echo "=== Done ==="
