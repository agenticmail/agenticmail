#!/bin/bash
set -euo pipefail

echo "=== AgenticMail Setup ==="

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "ERROR: Docker is not installed. Please install Docker first."
  exit 1
fi

if ! docker info &> /dev/null; then
  echo "ERROR: Docker is not running. Please start Docker."
  exit 1
fi

echo "✓ Docker is running"

# Find project root (look for docker-compose.yml)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

if [ ! -f "$PROJECT_ROOT/docker-compose.yml" ]; then
  echo "ERROR: Cannot find docker-compose.yml at $PROJECT_ROOT"
  exit 1
fi

cd "$PROJECT_ROOT"

# Start Stalwart
echo "Starting Stalwart mail server..."
docker compose up -d

# Wait for health
echo "Waiting for Stalwart to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/healthz > /dev/null 2>&1; then
    echo "✓ Stalwart is healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Stalwart did not become healthy in 30 seconds"
    exit 1
  fi
  sleep 1
done

# Run init if .env doesn't exist
if [ ! -f "$PROJECT_ROOT/.env" ]; then
  echo "Running first-time initialization..."
  cd "$PROJECT_ROOT" && npx tsx scripts/init-local.ts
fi

echo ""
echo "=== Setup Complete ==="
echo "Start the API server with: npm run dev:api"
