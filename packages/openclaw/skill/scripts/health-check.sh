#!/bin/bash
set -euo pipefail

# Check Stalwart
STALWART_OK=false
if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
  STALWART_OK=true
fi

# Check API
API_OK=false
if curl -sf http://127.0.0.1:3100/api/agenticmail/health > /dev/null 2>&1; then
  API_OK=true
fi

echo "{"
echo "  \"stalwart\": $STALWART_OK,"
echo "  \"api\": $API_OK,"
echo "  \"healthy\": $([ "$STALWART_OK" = true ] && [ "$API_OK" = true ] && echo true || echo false)"
echo "}"

if [ "$STALWART_OK" = true ] && [ "$API_OK" = true ]; then
  exit 0
else
  exit 1
fi
