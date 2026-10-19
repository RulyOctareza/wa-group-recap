#!/usr/bin/env bash
# Setup wa-group-recap di server: stack Evolution (Docker), instance WhatsApp, cron.
#
#   ./setup.sh                      # setup lengkap (QR)
#   ./setup.sh --number=08xxxx      # tautkan pakai kode pairing, bukan QR
#   ./setup.sh --install-docker     # install Docker dulu kalau belum ada (butuh sudo)
#   ./setup.sh --skip-compose       # pakai Evolution yang sudah jalan (atur EVOLUTION_URL,
#                                   # INSTANCE, PG_CONTAINER di .env)
#   ./setup.sh --no-cron            # jangan pasang cron
#
# Aman dijalankan ulang: .env & groups.txt yang sudah ada gak ditimpa, cron gak dobel.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)

INSTALL_DOCKER=0 SKIP_COMPOSE=0 NO_CRON=0 PAIR_NUMBER=""
for arg in "$@"; do
  case $arg in
    --install-docker) INSTALL_DOCKER=1 ;;
    --skip-compose) SKIP_COMPOSE=1 ;;
    --no-cron) NO_CRON=1 ;;
    --number=*) PAIR_NUMBER=${arg#*=} ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "opsi gak dikenal: $arg (lihat ./setup.sh --help)"; exit 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']$//g"; }
env_fill() { # isi KEY di .env kalau masih kosong
  if grep -qE "^$1=$" .env; then
    sed -i.bak "s|^$1=$|$1=$2|" .env && rm -f .env.bak
  fi
}

# ── Prasyarat ────────────────────────────────────────────────────
command -v python3 >/dev/null || die "python3 belum ada (apt install python3)"
python3 -c 'import zoneinfo' 2>/dev/null || die "butuh Python >= 3.9"
command -v curl >/dev/null || die "curl belum ada (apt install curl)"

if [ "$SKIP_COMPOSE" = 0 ]; then
  if ! command -v docker >/dev/null; then
    [ "$INSTALL_DOCKER" = 1 ] || die "Docker belum ada. Jalankan: ./setup.sh --install-docker"
    say "Install Docker"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    echo "Docker terpasang. Logout lalu login lagi (biar grup docker aktif), terus jalankan ulang ./setup.sh"
    exit 0
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 belum ada"
fi

# ── Config ───────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "Bikin .env dari .env.example"
  cp .env.example .env
fi
chmod 600 .env
env_fill POSTGRES_PASSWORD "$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
env_fill EVOLUTION_API_KEY "$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
[ -f groups.txt ] || cp groups.example.txt groups.txt
mkdir -p output logs

# ── Stack Evolution ──────────────────────────────────────────────
URL=$(env_get EVOLUTION_URL)
if [ "$SKIP_COMPOSE" = 0 ]; then
  say "Nyalain Evolution + Postgres + Redis"
  mkdir -p data
  docker compose up -d
fi
say "Nunggu Evolution siap di $URL"
for _ in $(seq 1 60); do
  curl -fsS "$URL" >/dev/null 2>&1 && break
  sleep 3
done
curl -fsS "$URL" >/dev/null 2>&1 || die "Evolution gak respon. Cek: docker compose logs evolution"

# ── Instance WhatsApp ────────────────────────────────────────────
say "Siapin instance WhatsApp"
CONNECT_ARGS=()
[ -n "$PAIR_NUMBER" ] && CONNECT_ARGS+=(--number "$PAIR_NUMBER")
[ -t 1 ] && CONNECT_ARGS+=(--wait)
python3 recap/connect.py "${CONNECT_ARGS[@]+"${CONNECT_ARGS[@]}"}" || true

# ── Cron ─────────────────────────────────────────────────────────
if [ "$NO_CRON" = 0 ]; then
  say "Pasang cron"
  EXPORT_CRON=$(env_get EXPORT_CRON)
  EXPORT_CRON=${EXPORT_CRON:-0 5 * * *}
  PY=$(command -v python3)
  MARK="# wa-group-recap $ROOT"
  {
    crontab -l 2>/dev/null | grep -vF "$ROOT/recap/" | grep -vF "$MARK" || true
    echo "$MARK"
    echo "* * * * * $PY $ROOT/recap/cleanup.py >> $ROOT/logs/cleanup.log 2>&1"
    echo "$EXPORT_CRON $PY $ROOT/recap/export.py >> $ROOT/logs/export.log 2>&1"
  } | crontab -
  crontab -l | grep -F "$ROOT/recap/"

  TZ_WANT=$(env_get TZ_NAME)
  TZ_HOST=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "?")
  if [ "$TZ_HOST" != "$TZ_WANT" ]; then
    echo "⚠️  Timezone server ($TZ_HOST) beda dengan TZ_NAME ($TZ_WANT); cron ikut jam server."
    echo "    Samakan: sudo timedatectl set-timezone $TZ_WANT"
  fi
fi

cat <<EOF

✓ Setup selesai. Langkah berikutnya:
  1. Pastikan WA tertaut:      python3 recap/connect.py --status   (harus "open")
  2. Pilih grup:               python3 recap/groups.py  → salin baris ke groups.txt
  3. Isi .env:                 RECIPIENTS, RECAP_API_URL (+ VERCEL_PROTECTION_BYPASS)
  4. Tes tanpa kirim:          python3 recap/export.py --date \$(date +%F) --dry-run
  Rekap otomatis jalan sesuai EXPORT_CRON ($(env_get EXPORT_CRON)).
EOF
