#!/usr/bin/env bash
#
# One-time Lightsail instance setup. Run once, by hand, after creating the
# instance and attaching a static IP:
#
#   scp deploy/bootstrap.sh ubuntu@<STATIC_IP>:~
#   ssh ubuntu@<STATIC_IP> 'bash bootstrap.sh'
#
# Idempotent, so re-running after a change is safe. Everything after this is
# handled by CI.

set -euo pipefail

APP_DIR=/opt/product-catalog

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

# --- Swap ---------------------------------------------------------------------
# A 2 GB instance runs Postgres, Node and nginx. Without swap, a memory spike
# during a deploy gets the OOM killer instead of a slow moment, and the OOM
# killer usually picks Postgres. 2 GB of swap turns a hard failure into a
# temporary slowdown. This is the single most valuable line in this script.
if ! swapon --show | grep -q '/swapfile'; then
  log "Creating 2 GB swapfile"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
  # Prefer RAM, but use swap rather than dying.
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' >/etc/sysctl.d/99-swappiness.conf
else
  log "Swap already configured"
fi

# --- Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker from Docker's own apt repository"
  # Ubuntu's packaged docker.io lags badly and ships no compose v2 plugin.
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
else
  log "Docker already installed: $(docker --version)"
fi

# Let the deploy user drive Docker without sudo, which is what the CI SSH
# session needs.
DEPLOY_USER="${SUDO_USER:-ubuntu}"
if ! id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
  log "Adding $DEPLOY_USER to the docker group"
  usermod -aG docker "$DEPLOY_USER"
fi

# --- Log rotation -------------------------------------------------------------
# Unbounded container logs are the classic way a small instance runs out of disk
# weeks after a successful launch.
log "Capping container log size"
cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker

# --- Firewall -----------------------------------------------------------------
# Lightsail has its own firewall in the console, which is the one that actually
# faces the internet. ufw is defence in depth for anything that bypasses it.
log "Configuring ufw"
apt-get install -y -qq ufw
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP - ACME challenge and redirect'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
ufw status verbose

# --- Unattended security upgrades --------------------------------------------
log "Enabling unattended security upgrades"
apt-get install -y -qq unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# --- App directory ------------------------------------------------------------
log "Preparing $APP_DIR"
mkdir -p "$APP_DIR"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

cat <<EOF

Bootstrap complete.

  Docker:   $(docker --version)
  Compose:  $(docker compose version --short)
  Swap:     $(free -h | awk '/Swap/ {print $2}')
  App dir:  $APP_DIR

Next:
  1. Point nike-catalog.me and www at this instance's static IP in Namecheap.
  2. Wait for DNS to resolve, then verify:  dig +short nike-catalog.me
  3. Add the GitHub secrets listed in the README.
  4. Run deploy/init-letsencrypt.sh on this box to issue the first certificate.
  5. Push to main. CI takes it from there.

NOTE: log out and back in before running docker without sudo — group membership
is only picked up by a new login session.
EOF
