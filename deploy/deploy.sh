#!/usr/bin/env bash
#
# Runs on the server, invoked by CI over SSH. Not usually run by hand.
#
#   ./deploy.sh <image-tag>
#
# The image tag is a git commit SHA, so what is running is always traceable to a
# commit, and rollback is a matter of pointing at the previous SHA rather than
# rebuilding anything.

set -euo pipefail

IMAGE_TAG="${1:?usage: deploy.sh <image-tag>}"
APP_DIR="${APP_DIR:-/opt/product-catalog}"
COMPOSE="docker compose -f docker-compose.prod.yml"
HEALTH_URL="http://127.0.0.1/health"
READY_URL="http://127.0.0.1/ready"

cd "$APP_DIR"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$1" >&2; }

# --- Remember what is currently running, for rollback ------------------------
PREVIOUS_TAG=""
if [[ -f .env ]] && grep -q '^IMAGE_TAG=' .env; then
  PREVIOUS_TAG="$(grep '^IMAGE_TAG=' .env | cut -d= -f2)"
fi
log "Deploying ${IMAGE_TAG}  (currently: ${PREVIOUS_TAG:-none})"

write_tag() {
  # Rewrite only the IMAGE_TAG line, leaving secrets in .env untouched.
  if grep -q '^IMAGE_TAG=' .env 2>/dev/null; then
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$1|" .env
  else
    echo "IMAGE_TAG=$1" >>.env
  fi
}

# --- Preflight ----------------------------------------------------------------
# Fail before touching the running service, not halfway through.
for required in POSTGRES_PASSWORD API_KEY; do
  if ! grep -q "^${required}=..*" .env 2>/dev/null; then
    fail "$required is missing from $APP_DIR/.env"
    exit 1
  fi
done

log "Pulling ghcr.io image ${IMAGE_TAG}"
write_tag "$IMAGE_TAG"
if ! $COMPOSE pull api; then
  fail "could not pull the image — leaving the running version alone"
  [[ -n "$PREVIOUS_TAG" ]] && write_tag "$PREVIOUS_TAG"
  exit 1
fi

# --- Database migration -------------------------------------------------------
# Runs as a one-off container on the new image, before the new code serves
# traffic. Idempotent, so a retried deploy is safe.
log "Ensuring Postgres is up"
$COMPOSE up -d postgres
$COMPOSE run --rm --entrypoint "node dist/db/migrate.js" api

# --- Roll the API -------------------------------------------------------------
log "Recreating the API container"
$COMPOSE up -d --no-deps api

log "Ensuring nginx and certbot are up"
$COMPOSE up -d nginx certbot

# --- Verify -------------------------------------------------------------------
# Through nginx on port 80, not directly at the container: this is the path real
# traffic takes, so it also catches a broken proxy config.
log "Waiting for readiness"
healthy=false
for attempt in $(seq 1 30); do
  if curl -fsS "$READY_URL" 2>/dev/null | grep -q '"status":"ready"'; then
    healthy=true
    echo "  ready after ${attempt}s"
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  fail "new version never became ready"
  $COMPOSE logs --no-color --tail 60 api || true

  if [[ -n "$PREVIOUS_TAG" && "$PREVIOUS_TAG" != "$IMAGE_TAG" ]]; then
    log "Rolling back to ${PREVIOUS_TAG}"
    write_tag "$PREVIOUS_TAG"
    $COMPOSE up -d --no-deps api
    for _ in $(seq 1 30); do
      curl -fsS "$READY_URL" >/dev/null 2>&1 && { echo "  rollback healthy"; break; }
      sleep 1
    done
    fail "deploy rolled back to ${PREVIOUS_TAG}"
  else
    fail "no previous version to roll back to"
  fi
  exit 1
fi

log "Verifying the API responds and the cache is working"
curl -fsS "$HEALTH_URL" >/dev/null
first=$(curl -fsS -o /dev/null -D - "http://127.0.0.1/api/v1/products?limit=1" | grep -i '^x-cache-status' | tr -d '\r' || true)
second=$(curl -fsS -o /dev/null -D - "http://127.0.0.1/api/v1/products?limit=1" | grep -i '^x-cache-status' | tr -d '\r' || true)
echo "  ${first:-no cache header}"
echo "  ${second:-no cache header}"

# --- Clean up -----------------------------------------------------------------
# Old images accumulate and a 60 GB disk is not infinite. Keeps the previous
# image so rollback stays instant, drops anything older.
log "Pruning unused images"
docker image prune -f --filter "until=168h" >/dev/null || true

log "Deployed ${IMAGE_TAG}"
docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'
