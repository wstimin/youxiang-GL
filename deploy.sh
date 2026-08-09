#!/bin/sh
set -eu

REPOSITORY="wstimin/youxiang-GL"
IMAGE_REPOSITORY="wstimin/youxiang-gl"
BRANCH="main"
INSTALL_DIR="${INSTALL_DIR:-/opt/icloud-hq}"
RAW_BASE="https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}"
COMPOSE_FILE="compose.production.yaml"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

prompt() {
  label="$1"
  default_value="${2:-}"
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >/dev/tty
  else
    printf '%s: ' "$label" >/dev/tty
  fi
  IFS= read -r answer </dev/tty
  if [ -z "$answer" ]; then answer="$default_value"; fi
  REPLY="$answer"
}

prompt_secret() {
  label="$1"
  printf '%s: ' "$label" >/dev/tty
  stty -echo </dev/tty
  IFS= read -r answer </dev/tty
  stty echo </dev/tty
  printf '\n' >/dev/tty
  REPLY="$answer"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      exec sudo -E sh "$0" "$@"
    fi
    fail "Run this script as root."
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi
  command -v curl >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update
      apt-get install -y ca-certificates curl
    else
      fail "Install curl and Docker, then run this script again."
    fi
  }
  say "Installing Docker Engine..."
  installer="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
  rm -f "$installer"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable."
}

download_runtime_files() {
  mkdir -p "$INSTALL_DIR"
  mkdir -p "${INSTALL_DIR}/backups"
  curl -fsSL "${RAW_BASE}/${COMPOSE_FILE}" -o "${INSTALL_DIR}/${COMPOSE_FILE}"
  curl -fsSL "${RAW_BASE}/Caddyfile" -o "${INSTALL_DIR}/Caddyfile"
  curl -fsSL "${RAW_BASE}/scripts/backup.sh" -o "${INSTALL_DIR}/backup.sh"
  chmod 700 "${INSTALL_DIR}/backup.sh"
}

create_environment() {
  env_file="${INSTALL_DIR}/.env"
  if [ -f "$env_file" ]; then
    say "Existing .env found; preserving configuration and secrets."
    return
  fi

  prompt "Public domain, for example code.example.com"
  DOMAIN="$REPLY"
  prompt "Let's Encrypt email"
  ACME_EMAIL="$REPLY"
  prompt "Initial administrator email"
  ADMIN_EMAIL="$REPLY"
  prompt_secret "Initial administrator password (at least 8 characters)"
  ADMIN_PASSWORD="$REPLY"
  prompt "Administrator IP allowlist, comma-separated; leave blank for any IP"
  ADMIN_ALLOWED_IPS="$REPLY"

  printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || fail "Invalid domain."
  printf '%s' "$ACME_EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' || fail "Invalid certificate email."
  printf '%s' "$ADMIN_EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' || fail "Invalid administrator email."
  [ "${#ADMIN_PASSWORD}" -ge 8 ] || fail "Administrator password must contain at least 8 characters."
  printf '%s' "$ADMIN_PASSWORD" | grep -Eq '^[A-Za-z0-9._~-]+$' || fail "Initial password may only contain letters, numbers, dot, underscore, tilde, and hyphen."
  if [ -n "$ADMIN_ALLOWED_IPS" ]; then
    printf '%s\n' "$ADMIN_ALLOWED_IPS" | grep -Eq '^[A-Fa-f0-9:.,[:space:]]+$' || fail "Invalid administrator IP allowlist."
  fi

  command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required to generate secrets."
  umask 077
  cat > "$env_file" <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
MASTER_KEY_HEX=$(openssl rand -hex 32)
TOKEN_PEPPER_HEX=$(openssl rand -hex 32)
POSTGRES_DB=codevault
POSTGRES_USER=codevault
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_IMAGE=ghcr.io/${IMAGE_REPOSITORY}:latest
SESSION_HOURS=12
CODE_TTL_MINUTES=10
IMAP_POLL_SECONDS=15
MAX_MESSAGE_BYTES=1048576
QUERY_LIMIT_PER_10_MINUTES=30
BATCH_QUERY_LIMIT_PER_10_MINUTES=50
LOGIN_LIMIT_PER_15_MINUTES=10
QUERY_FAILURE_LIMIT_PER_15_MINUTES=8
LOGIN_FAILURE_LIMIT_PER_15_MINUTES=5
UNMATCHED_RETENTION_DAYS=14
AUDIT_RETENTION_DAYS=90
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_DAYS=14
TRUST_PROXY=1
ADMIN_ALLOWED_IPS=${ADMIN_ALLOWED_IPS}
EOF
  chmod 600 "$env_file"
}

deploy() {
  cd "$INSTALL_DIR"
  rollback_image="ghcr.io/${IMAGE_REPOSITORY}:rollback"
  current_image="$(sed -n 's/^APP_IMAGE=//p' .env)"
  [ -n "$current_image" ] || current_image="ghcr.io/${IMAGE_REPOSITORY}:latest"

  if docker compose -f "$COMPOSE_FILE" ps --status running db 2>/dev/null | grep -q db; then
    say "Creating a pre-update database backup..."
    docker compose -f "$COMPOSE_FILE" run --rm backup sh /usr/local/bin/backup.sh once
  fi
  if docker image inspect "$current_image" >/dev/null 2>&1; then
    docker tag "$current_image" "$rollback_image"
  fi

  say "Pulling the latest application image..."
  if ! docker compose -f "$COMPOSE_FILE" pull; then
    fail "Unable to pull the container image. Confirm that the GHCR package is public and the GitHub Actions build has completed."
  fi
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
  say "Waiting for the web service health check..."
  attempts=0
  while [ "$attempts" -lt 24 ]; do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(docker compose -f "$COMPOSE_FILE" ps -q web)" 2>/dev/null || true)"
    [ "$health" = "healthy" ] && break
    attempts=$((attempts + 1))
    sleep 5
  done
  if [ "${health:-}" != "healthy" ]; then
    say "The new release did not become healthy. Restoring the previous image..."
    if docker image inspect "$rollback_image" >/dev/null 2>&1; then
      APP_IMAGE="$rollback_image" docker compose -f "$COMPOSE_FILE" up -d --force-recreate --pull never web worker
      fail "Update failed and the previous application image was restored. Check Docker logs before retrying."
    fi
    fail "Update failed and no previous image was available for rollback."
  fi
  docker compose -f "$COMPOSE_FILE" ps
}

main() {
  require_root "$@"
  install_docker
  download_runtime_files
  create_environment
  deploy
  say ""
  say "Deployment complete."
  say "Public page: https://$(sed -n 's/^DOMAIN=//p' "${INSTALL_DIR}/.env")/"
  say "Administrator: https://$(sed -n 's/^DOMAIN=//p' "${INSTALL_DIR}/.env")/admin/login"
  say "Run this same script again whenever you want to update to the latest image."
}

main "$@"
