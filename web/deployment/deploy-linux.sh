#!/usr/bin/env bash
# BLSD Tool: Ubuntu 24.04 deployment. Run from the extracted release bundle.
set -Eeuo pipefail
umask 022

APP=/opt/blsd-studio
SERVICE=blsd
ACCOUNT=blsd
NODE_VERSION=24.21.0
CERT_NAME=blsd-studio
SITE=/etc/nginx/sites-available/blsd-studio
UNIT=/etc/systemd/system/blsd.service
STATE=/etc/blsd-studio
# Retain the original installation marker so earlier releases remain updatable.
MARKER='Managed by BLSD Studio deploy-linux.sh'
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
DOMAIN= EMAIL= HTTPS=0 AGREE_TOS=0 UPDATE=0 DRY_RUN=0
STAGE= BACKUP= WORK= SNAPSHOT= NODE= ARCH= ACTIVE_BEFORE=0 PROMOTED=0 SITE_CHANGED=0
SITE_EXISTED=0 UNIT_EXISTED=0 ENABLED_EXISTED=0 SERVICE_CHANGED=0 COMMITTED=0
SERVICE_ENABLED_BEFORE=0

usage() {
  cat <<'USAGE'
BLSD Tool automatic deployment for Ubuntu 24.04 LTS (x86_64/aarch64)

  sudo bash deployment/deploy-linux.sh --domain analysis.example.org
  sudo bash deployment/deploy-linux.sh --domain analysis.example.org \
       --https --email admin@example.org --agree-tos

Options:
  --domain HOST   DNS hostname, or a literal IPv4 address for HTTP only (required).
  --https         Obtain/maintain a Let's Encrypt certificate and redirect to HTTPS.
  --email EMAIL   Certificate contact address; required with --https.
  --agree-tos     Operator accepts the Let's Encrypt subscriber agreement.
                  Required with --https; see https://letsencrypt.org/repository/ .
  --update        Replace a previous installation made by this script.
                  Previous files are retained under /opt/blsd-studio.previous-* .
  --dry-run       Validate the bundle/options and print the plan; change nothing.
  --help          Show this help.

The service listens only on 127.0.0.1:4174. Nginx publishes the root URL.
Set DNS and the cloud firewall (80/443) first; keep your SSH access rule.
The script does not enable UFW, modify DNS/cloud accounts, or install OS upgrades.
USAGE
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[BLSD] %s\n' "$*"; }
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "Missing value for $1"; }

certificate_belongs_to_domain() {
  local state_dir=$1 expected_domain=$2 recorded_domain
  [[ -f "$state_dir/certificate-domain" ]] || return 1
  IFS= read -r recorded_domain < "$state_dir/certificate-domain" || return 1
  [[ "$recorded_domain" == "$expected_domain" ]]
}

while (($#)); do
  case "$1" in
    --domain) need_value "$@"; DOMAIN=$2; shift 2 ;;
    --email) need_value "$@"; EMAIL=$2; shift 2 ;;
    --https) HTTPS=1; shift ;;
    --agree-tos) AGREE_TOS=1; shift ;;
    --update) UPDATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
done

# Hostnames are used as Nginx tokens and Certbot arguments. No schemes, ports,
# wildcard names, paths, whitespace, shell fragments, or leading flags accepted.
DOMAIN=${DOMAIN,,}
[[ -n "$DOMAIN" ]] || fail '--domain is required (a DNS hostname or an IPv4 address).'
[[ ${#DOMAIN} -le 253 && "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail 'Invalid --domain.'
[[ "$DOMAIN" != *..* ]] || fail 'Invalid --domain: empty label.'
IFS=. read -r -a labels <<< "$DOMAIN"
for label in "${labels[@]}"; do
  [[ ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || fail 'Invalid --domain label.'
done
IS_IPV4=0
if [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then
  [[ ${#labels[@]} -eq 4 ]] || fail 'Invalid IPv4 address.'
  for label in "${labels[@]}"; do
    [[ ${#label} -le 3 && "$label" != 0[0-9]* && $((10#$label)) -le 255 ]] || fail 'Invalid IPv4 address.'
  done
  IS_IPV4=1
else
  [[ "$DOMAIN" == *.* ]] || fail 'Use a fully qualified DNS hostname.'
fi
if ((HTTPS)); then
  ((IS_IPV4 == 0)) || fail '--https requires a DNS hostname, not an IP address.'
  [[ "$EMAIL" =~ ^[A-Za-z0-9.!#%+_/=-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$ ]] || fail 'A valid --email is required with --https.'
  ((AGREE_TOS)) || fail '--https requires the operator to explicitly pass --agree-tos.'
else
  [[ -z "$EMAIL" && $AGREE_TOS -eq 0 ]] || fail '--email and --agree-tos require --https.'
fi
for relative in package.json dist/client/index.html server/index.mjs server/api.mjs \
  server/results-download.mjs server/readable-results.mjs server/results-workbook.mjs server/analysis-downloads.mjs server/job-lifecycle.mjs server/async-tasks.mjs server/task-results.mjs \
  server/blsd_adapter.R server/blsd_export.R \
  src/ageGroups.js src/bothGroups.js deployment/check-environment.mjs \
  deployment/check-r.R deployment/fonts.conf.example deployment/deploy-linux.sh \
  deployment/start-linux.sh deployment/install-r-packages.R \
  deployment/blsd.service.example deployment/nginx.conf.example; do
  [[ -f "$SOURCE/$relative" && ! -L "$SOURCE/$relative" ]] || fail "Incomplete bundle: $relative"
done
[[ "$SOURCE" != "$APP" && "$SOURCE" != "$APP/"* ]] || fail 'Extract the new release outside /opt/blsd-studio before deploying.'

if ((DRY_RUN)); then
  cat <<PLAN
Validated release: $SOURCE
Target: Ubuntu 24.04 LTS, x86_64 or aarch64
Install: $APP; service/account: $SERVICE/$ACCOUNT; upstream: 127.0.0.1:4174
1. Check existing installation, service and Nginx configuration; require --update for replacement.
2. Install Ubuntu packages: Nginx, R, mgcv, jsonlite, scales, ggplot2, Cairo/font dependencies and fonts.
3. Reuse system Node.js >=22.12 or install checksum-verified official Node.js $NODE_VERSION.
4. Stage runtime, install font aliases, and check R/packages/Cairo as the service account.
5. Back up and atomically replace the application; install/start systemd service.
6. Test Nginx configuration and upstream health; publish http://$DOMAIN/ .
7. If UFW is already active, allow 80/tcp and 443/tcp; preserve other rules.
HTTPS requested: $HTTPS; explicit subscriber-agreement acceptance: $AGREE_TOS
PLAN
  ((HTTPS == 0)) || printf '8. Install Certbot, request HTTPS for %s, enable redirect and check certificate renewal.\n' "$DOMAIN"
  printf 'No commands were executed that change the system. DNS and cloud firewall remain operator tasks.\n'
  exit 0
fi

((EUID == 0)) || fail 'Run with sudo, or use --dry-run for a read-only preview.'
[[ -f /etc/os-release ]] || fail 'Only Ubuntu 24.04 LTS is supported.'
# Parse only the two necessary literal values; do not source an arbitrary file.
OS_ID=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
OS_VERSION=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
[[ "$OS_ID" == ubuntu && "$OS_VERSION" == 24.04 ]] || fail 'Only Ubuntu 24.04 LTS is supported.'
[[ -d /run/systemd/system ]] || fail 'A running systemd host is required (not a plain container).'
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) fail 'Supported architectures: x86_64 and aarch64.' ;; esac
[[ ! -L "$APP" && ! -L "$SITE" && ! -L "$UNIT" && ! -L "$STATE" ]] || fail 'Refusing an unexpected symbolic link at a managed destination.'
[[ ! -L /var/backups/blsd-studio ]] || fail 'Unexpected symlink at the configuration-backup destination.'
[[ ! -L /etc/fonts/conf.d/99-blsd-fonts.conf ]] || fail 'Unexpected symlink at the font-alias destination.'
if [[ -e /etc/fonts/conf.d/99-blsd-fonts.conf ]]; then
  cmp -s "$SOURCE/deployment/fonts.conf.example" /etc/fonts/conf.d/99-blsd-fonts.conf || fail 'A different BLSD font-alias file exists; review it before deployment.'
fi
if [[ -e "$APP" ]]; then
  [[ -d "$APP" && -f "$APP/.blsd-managed-install" ]] || fail "$APP exists but was not installed by this script; move it aside first."
  ((UPDATE)) || fail 'An installation already exists. Re-run with --update to keep a backup and replace it.'
fi
for target in "$SITE" "$UNIT"; do
  [[ ! -e "$target" ]] || grep -Fq "$MARKER" "$target" || fail "Unmanaged configuration exists: $target"
done
if [[ -e /etc/nginx/sites-enabled/blsd-studio || -L /etc/nginx/sites-enabled/blsd-studio ]]; then
  [[ -L /etc/nginx/sites-enabled/blsd-studio && $(readlink /etc/nginx/sites-enabled/blsd-studio) == "$SITE" ]] || fail 'An unmanaged Nginx enabled-site entry exists.'
fi
if [[ -f "$SITE" ]] && grep -Eq 'ssl_certificate|listen[^;]*443' "$SITE"; then
  [[ -f "$STATE/domain" && $(cat "$STATE/domain") == "$DOMAIN" ]] || fail 'Changing an existing HTTPS hostname requires a separate certificate/Nginx migration.'
  PRESERVE_TLS=1
else
  PRESERVE_TLS=0
fi
if ((HTTPS)) && [[ -f /etc/letsencrypt/renewal/blsd-studio.conf ]]; then
  certificate_belongs_to_domain "$STATE" "$DOMAIN" || fail 'A blsd-studio certificate already exists outside this managed hostname; review it before deployment.'
fi
check_port_owner() {
  local listeners main_pid line
  listeners=$(ss -H -ltnp 'sport = :4174')
  [[ -n "$listeners" ]] || return 0
  main_pid=$(systemctl show --property=MainPID --value "$SERVICE" 2>/dev/null || true)
  [[ -f "$APP/.blsd-managed-install" && "$main_pid" =~ ^[1-9][0-9]*$ ]] || fail 'Port 4174 is already occupied by an unrelated process.'
  while IFS= read -r line; do
    [[ "$line" == *"pid=$main_pid,"* ]] || fail 'Port 4174 has a listener outside the managed blsd service.'
  done <<< "$listeners"
}
command -v ss >/dev/null && check_port_owner
command -v flock >/dev/null || fail 'flock (util-linux) is required.'
exec 9>/run/lock/blsd-studio-deploy.lock
flock -n 9 || fail 'Another BLSD deployment is running.'
WORK=$(mktemp -d /tmp/blsd-deploy.XXXXXXXX)
STAGE=$(mktemp -d /opt/.blsd-studio-stage.XXXXXXXX)
install -d -m 700 -- /var/backups/blsd-studio
SNAPSHOT=$(mktemp -d "/var/backups/blsd-studio/config-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
[[ -e "$SITE" ]] && { SITE_EXISTED=1; cp -a -- "$SITE" "$SNAPSHOT/site.before"; }
[[ -e "$UNIT" ]] && { UNIT_EXISTED=1; cp -a -- "$UNIT" "$SNAPSHOT/unit.before"; }
[[ ! -f "$STATE/domain" ]] || cp -a -- "$STATE/domain" "$SNAPSHOT/domain.before"
[[ ! -f "$STATE/certificate-domain" ]] || cp -a -- "$STATE/certificate-domain" "$SNAPSHOT/certificate-domain.before"
[[ -L /etc/nginx/sites-enabled/blsd-studio ]] && ENABLED_EXISTED=1
systemctl is-active --quiet "$SERVICE" && ACTIVE_BEFORE=1 || true
systemctl is-enabled --quiet "$SERVICE" && SERVICE_ENABLED_BEFORE=1 || true

rollback() {
  local status=$?
  trap - EXIT INT TERM
  if ((status != 0 && COMMITTED == 0)); then
    printf '\n[BLSD] Deployment failed; restoring the previous application/service/site where changed.\n' >&2
    if ((SERVICE_CHANGED)); then systemctl stop "$SERVICE" >/dev/null 2>&1 || true; fi
    if ((PROMOTED)); then
      # Keep failed artifacts for diagnosis; never recursively delete an app path.
      mv -- "$APP" "$APP.failed-$(date -u +%Y%m%dT%H%M%SZ)-$$" || true
      [[ -z "$BACKUP" ]] || mv -- "$BACKUP" "$APP" || true
    elif [[ -n "$BACKUP" && ! -e "$APP" ]]; then
      mv -- "$BACKUP" "$APP" || true
    fi
    if ((SERVICE_CHANGED)); then
      if ((UNIT_EXISTED)); then cp -a -- "$SNAPSHOT/unit.before" "$UNIT"; else rm -f -- "$UNIT"; fi
      systemctl daemon-reload || true
      if ((SERVICE_ENABLED_BEFORE)); then systemctl enable "$SERVICE" >/dev/null 2>&1 || true; else systemctl disable "$SERVICE" >/dev/null 2>&1 || true; fi
      if ((ACTIVE_BEFORE)); then systemctl start "$SERVICE" || true; fi
    fi
    if ((SITE_CHANGED)); then
      if ((SITE_EXISTED)); then cp -a -- "$SNAPSHOT/site.before" "$SITE"; else rm -f -- "$SITE"; fi
      ((ENABLED_EXISTED)) || rm -f -- /etc/nginx/sites-enabled/blsd-studio
      nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    fi
    printf '[BLSD] Installed OS packages, font aliases and issued certificates are retained. See journalctl -u blsd -n 100.\n' >&2
    printf '[BLSD] Configuration snapshots: %s\n' "$SNAPSHOT" >&2
  fi
  # These two directories are created by mktemp in this invocation only.
  [[ "$STAGE" != /opt/.blsd-studio-stage.* ]] || rm -rf -- "$STAGE"
  [[ "$WORK" != /tmp/blsd-deploy.* ]] || rm -rf -- "$WORK"
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log 'Installing dependencies (named packages may be updated; no full OS upgrade).'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends software-properties-common ca-certificates curl xz-utils fontconfig
add-apt-repository -y universe
apt-get update
apt-get install -y --no-install-recommends nginx iproute2 r-base r-cran-mgcv r-cran-jsonlite \
  r-cran-scales r-cran-ggplot2 fonts-noto-cjk fonts-liberation
check_port_owner

node_supported() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1
}
candidate=$(command -v node || true)
resolved_node=
[[ -z "$candidate" ]] || resolved_node=$(readlink -f -- "$candidate" || true)
if [[ "$resolved_node" == /usr/* || "$resolved_node" == /opt/* ]] && \
  [[ "$resolved_node" =~ ^[A-Za-z0-9_./+-]+$ && -x "$resolved_node" ]] && node_supported "$resolved_node"; then
  NODE=$resolved_node
else
  NODE_HOME="/opt/node-v$NODE_VERSION-linux-$ARCH"
  [[ ! -L "$NODE_HOME" ]] || fail 'Unexpected symlink at the Node.js installation directory.'
  if [[ ! -e "$NODE_HOME" ]]; then
    log "Downloading official Node.js $NODE_VERSION ($ARCH) with SHA-256 verification."
    node_archive="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
    curl --fail --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
      "https://nodejs.org/download/release/v$NODE_VERSION/$node_archive" -o "$WORK/$node_archive"
    curl --fail --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
      "https://nodejs.org/download/release/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
    awk -v name="$node_archive" '$2 == name { print }' "$WORK/SHASUMS256.txt" > "$WORK/node.sha256"
    [[ $(wc -l < "$WORK/node.sha256") -eq 1 ]] || fail 'Official checksum entry was missing or ambiguous.'
    (cd -- "$WORK" && sha256sum --check node.sha256)
    tar -xJf "$WORK/$node_archive" -C "$WORK"
    chown -R root:root -- "$WORK/node-v$NODE_VERSION-linux-$ARCH"
    mv -- "$WORK/node-v$NODE_VERSION-linux-$ARCH" "$NODE_HOME"
  fi
  NODE="$NODE_HOME/bin/node"
  [[ -x "$NODE" ]] && node_supported "$NODE" || fail 'The installed Node.js runtime is unavailable or too old.'
fi
log "Using $NODE ($("$NODE" --version))."
getent group "$ACCOUNT" >/dev/null || groupadd --system "$ACCOUNT"
if id -u "$ACCOUNT" >/dev/null 2>&1; then
  [[ $(id -u "$ACCOUNT") -ne 0 && $(id -gn "$ACCOUNT") == "$ACCOUNT" ]] || fail 'The existing blsd account must be non-root with primary group blsd.'
else
  useradd --system --gid "$ACCOUNT" --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
fi

log 'Staging the production runtime and checking R, Cairo and fonts.'
install -d -m 755 -- "$STAGE/dist" "$STAGE/server" "$STAGE/src" "$STAGE/deployment"
cp -a -- "$SOURCE/dist/client" "$STAGE/dist/client"
install -m 644 -- "$SOURCE/package.json" "$STAGE/package.json"
for file in index.mjs api.mjs results-download.mjs readable-results.mjs results-workbook.mjs analysis-downloads.mjs job-lifecycle.mjs async-tasks.mjs task-results.mjs blsd_adapter.R blsd_export.R; do
  install -m 644 -- "$SOURCE/server/$file" "$STAGE/server/$file"
done
for file in ageGroups.js bothGroups.js; do install -m 644 -- "$SOURCE/src/$file" "$STAGE/src/$file"; done
for file in deploy-linux.sh start-linux.sh check-environment.mjs check-r.R install-r-packages.R fonts.conf.example blsd.service.example nginx.conf.example; do
  install -m 644 -- "$SOURCE/deployment/$file" "$STAGE/deployment/$file"
done
# Preserve release identity, operating instructions and bundled-asset licenses.
# Development-tree dry runs remain supported before a release manifest exists.
for file in LICENSE THIRD_PARTY_NOTICES.txt RELEASE_MANIFEST.json DEPLOYMENT_LINUX_zh.txt; do
  if [[ -f "$SOURCE/$file" && ! -L "$SOURCE/$file" ]]; then
    install -m 644 -- "$SOURCE/$file" "$STAGE/$file"
  fi
done
printf '%s\n' "$MARKER" > "$STAGE/.blsd-managed-install"
chown -R root:root -- "$STAGE"
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 700 -- "$STAGE/server/.jobs"
install -m 644 -- "$SOURCE/deployment/fonts.conf.example" /etc/fonts/conf.d/99-blsd-fonts.conf
fc-cache -f
runuser -u "$ACCOUNT" -- fc-match 'Microsoft YaHei'
runuser -u "$ACCOUNT" -- fc-match Arial
runuser -u "$ACCOUNT" -- env LANG=C.UTF-8 LC_ALL=C.UTF-8 BLSD_RSCRIPT=/usr/bin/Rscript \
  "$NODE" "$STAGE/deployment/check-environment.mjs"

log 'Installing the application and systemd service.'
SERVICE_CHANGED=1
if systemctl is-active --quiet "$SERVICE"; then
  systemctl stop "$SERVICE"
else
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
fi
if [[ -e "$APP" ]]; then
  BACKUP="$APP.previous-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv -- "$APP" "$BACKUP"
fi
# Same-filesystem rename: no partially copied live application.
mv -- "$STAGE" "$APP"
PROMOTED=1
cat > "$UNIT" <<EOF
# $MARKER
[Unit]
Description=BLSD Tool analysis service
After=network.target

[Service]
Type=simple
User=$ACCOUNT
Group=$ACCOUNT
WorkingDirectory=$APP
Environment=PORT=4174
Environment=BLSD_RSCRIPT=/usr/bin/Rscript
Environment=BLSD_TRUST_PROXY=loopback
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
ExecStart=$NODE $APP/server/index.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=600
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP/server/.jobs

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable --now "$SERVICE"

check_health() {
  local url=$1; shift
  curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 --noproxy '*' \
    --connect-timeout 5 --max-time 30 "$@" "$url" -o "$WORK/health.json"
  "$NODE" -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(x.available!==true)process.exit(1)' "$WORK/health.json"
}
check_health http://127.0.0.1:4174/api/health
systemctl is-active --quiet "$SERVICE" || fail 'The new blsd systemd service is not active.'
check_port_owner

log 'Configuring Nginx without replacing other sites.'
if ((PRESERVE_TLS == 0)); then
  SITE_CHANGED=1
  cat > "$SITE" <<EOF
# $MARKER
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:4174;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        # The web client submits asynchronous jobs and polls; the legacy
        # synchronous API remains available within this proxy timeout.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
  chmod 644 "$SITE"
fi
((ENABLED_EXISTED)) || SITE_CHANGED=1
ln -sfn -- "$SITE" /etc/nginx/sites-enabled/blsd-studio
nginx -t
systemctl enable --now nginx
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi
if ((PRESERVE_TLS)); then
  check_health "https://$DOMAIN/api/health" --resolve "$DOMAIN:443:127.0.0.1"
else
  check_health "http://$DOMAIN/api/health" --resolve "$DOMAIN:80:127.0.0.1"
fi

if ((HTTPS)); then
  log 'Requesting HTTPS with the operator-supplied agreement flag.'
  apt-get install -y --no-install-recommends certbot python3-certbot-nginx
  SITE_CHANGED=1
  # Retain ownership even if issuance succeeds but a later health/renewal check
  # fails and triggers rollback. The next same-host attempt can safely retry.
  install -d -m 755 -- "$STATE"
  printf '%s\n' "$DOMAIN" > "$STATE/certificate-domain"
  chmod 644 "$STATE/certificate-domain"
  certbot --nginx --non-interactive --agree-tos --email "$EMAIL" --cert-name "$CERT_NAME" \
    --domain "$DOMAIN" --redirect --keep-until-expiring
  nginx -t
  systemctl reload nginx
  check_health "https://$DOMAIN/api/health" --resolve "$DOMAIN:443:127.0.0.1"
  systemctl enable --now certbot.timer
  certbot renew --cert-name "$CERT_NAME" --dry-run --non-interactive
fi
install -d -m 755 -- "$STATE"
printf '%s\n' "$DOMAIN" > "$STATE/domain"
chmod 644 "$STATE/domain"
cp -a -- "$UNIT" "$SNAPSHOT/unit.installed"
cp -a -- "$SITE" "$SNAPSHOT/site.installed"
cp -a -- "$STATE/domain" "$SNAPSHOT/domain.installed"
COMMITTED=1
if ((HTTPS || PRESERVE_TLS)); then PUBLIC_SCHEME=https; else PUBLIC_SCHEME=http; fi
log "Deployment complete: $PUBLIC_SCHEME://$DOMAIN/"
[[ -z "$BACKUP" ]] || printf 'Previous application retained: %s\n' "$BACKUP"
printf 'Configuration snapshots: %s\n' "$SNAPSHOT"
printf 'Service: systemctl status blsd\nLogs: journalctl -u blsd -n 100\n'
printf 'Verify an external browser can fit data and export Chinese PDF/PNG. DNS and cloud firewall must permit the URL.\n'
