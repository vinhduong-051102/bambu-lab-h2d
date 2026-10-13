#!/usr/bin/env bash
# Redeploy the gateway after a source update: install deps, check, build, restart the systemd service.
#
# Usage: scripts/redeploy.sh [--pull] [--skip-tests]
#   --pull        git pull --ff-only before building
#   --skip-tests  skip typecheck and unit tests
#
# Env overrides: SERVICE_NAME (default h2d-monitor), HEALTH_URL (default http://localhost:$HTTP_PORT/api/health)
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE_NAME="${SERVICE_NAME:-h2d-monitor}"
PULL=false
SKIP_TESTS=false

for arg in "$@"; do
  case "$arg" in
    --pull) PULL=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ -z "${HEALTH_URL:-}" ]]; then
  port="$(grep -E '^HTTP_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
  HEALTH_URL="http://localhost:${port:-3000}/api/health"
fi

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if $PULL; then
  step "git pull"
  git pull --ff-only
fi

step "npm install"
npm install --no-audit --no-fund

if ! $SKIP_TESTS; then
  step "typecheck"
  npm run typecheck
  step "tests"
  npm test
fi

step "build"
npm run build

step "restart $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

step "health check $HEALTH_URL"
for _ in $(seq 1 60); do
  if curl -sf "$HEALTH_URL" >/dev/null; then
    echo "OK: $(git log -1 --oneline) is running"
    exit 0
  fi
  sleep 1
done

echo "Health check failed after 60s. Recent logs:" >&2
journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2
exit 1
