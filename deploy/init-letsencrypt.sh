#!/usr/bin/env bash
#
# Issues the first TLS certificate. Run once on the server, after DNS points at
# it and after the first deploy has placed the compose files in /opt/product-catalog.
#
#   ssh ubuntu@<STATIC_IP>
#   cd /opt/product-catalog && ./init-letsencrypt.sh
#
# Renewal after this is automatic — the certbot service in the compose file
# checks twice a day.
#
# The chicken-and-egg problem this solves: nginx will not start if its config
# points at a certificate file that does not exist, but certbot cannot complete
# an HTTP-01 challenge without a running web server on port 80. So we plant a
# self-signed placeholder, start nginx, get the real certificate, and reload.

set -euo pipefail

DOMAIN=nike-catalog.me
ALT_DOMAIN=www.nike-catalog.me
EMAIL="${LETSENCRYPT_EMAIL:-}"
COMPOSE="docker compose -f docker-compose.prod.yml"

if [[ -z "$EMAIL" ]]; then
  echo "Set LETSENCRYPT_EMAIL first — Let's Encrypt sends expiry warnings there." >&2
  echo "  LETSENCRYPT_EMAIL=you@example.com ./init-letsencrypt.sh" >&2
  exit 1
fi

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

# --- Confirm DNS actually points here ----------------------------------------
# Let's Encrypt rate-limits failures (5 per hostname per hour). Checking DNS
# first turns a wasted hour into an immediate, obvious error.
log "Checking DNS"
SERVER_IP="$(curl -fsS https://checkip.amazonaws.com || echo unknown)"
DOMAIN_IP="$(dig +short "$DOMAIN" A | tail -1)"
echo "  this server: $SERVER_IP"
echo "  $DOMAIN:     ${DOMAIN_IP:-unresolved}"

if [[ "$DOMAIN_IP" != "$SERVER_IP" ]]; then
  echo "
DNS does not point at this server yet. Fix the A records in Namecheap and wait
for propagation before retrying, or Let's Encrypt will rate-limit you." >&2
  read -r -p "Continue anyway? [y/N] " reply
  [[ "$reply" == "y" ]] || exit 1
fi

# --- Plant a placeholder so nginx can boot -----------------------------------
CERT_PATH="/etc/letsencrypt/live/$DOMAIN"

if $COMPOSE run --rm --entrypoint "test -f $CERT_PATH/fullchain.pem" certbot 2>/dev/null; then
  log "A certificate already exists — skipping issuance"
else
  log "Creating a self-signed placeholder so nginx can start"
  $COMPOSE run --rm --entrypoint "\
    sh -c 'mkdir -p $CERT_PATH && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout $CERT_PATH/privkey.pem \
      -out $CERT_PATH/fullchain.pem \
      -subj \"/CN=localhost\"'" certbot

  log "Starting nginx to serve the ACME challenge"
  $COMPOSE up -d nginx
  sleep 5

  log "Deleting the placeholder and requesting the real certificate"
  $COMPOSE run --rm --entrypoint "rm -rf /etc/letsencrypt/live/$DOMAIN \
    /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf" certbot

  $COMPOSE run --rm --entrypoint "\
    certbot certonly --webroot -w /var/www/certbot \
      -d $DOMAIN -d $ALT_DOMAIN \
      --email $EMAIL \
      --agree-tos --no-eff-email \
      --non-interactive" certbot

  log "Reloading nginx with the real certificate"
  $COMPOSE exec nginx nginx -s reload
fi

log "Verifying TLS from the outside"
if curl -fsS -o /dev/null -w '  HTTPS status: %{http_code}\n' "https://$DOMAIN/health"; then
  echo "
TLS is live. https://$DOMAIN/health is responding."
else
  echo "
Certificate issued but the health check did not pass. Check: $COMPOSE logs nginx api" >&2
  exit 1
fi
