#!/usr/bin/env bash
# Setup wa-group-recap di server. Dua mode tangkap pesan:
#
#   Evolution (default): stack Docker Evolution API, online 24 jam, pesan disimpan di Postgres
#     ./setup.sh                      # setup lengkap (QR)
#     ./setup.sh --number=08xxxx      # tautkan pakai kode pairing, bukan QR
#     ./setup.sh --install-docker     # install Docker dulu kalau belum ada (butuh sudo)
#     ./setup.sh --skip-compose       # pakai Evolution yang sudah jalan (atur .env)
#
#   WhatsApp Web: whatsapp-web.js + Chrome, cuma dibuka saat rekap harian (tanpa Docker/DB)
#     ./setup.sh --webjs              # npm install, login WA Web (QR), cron harian
#     ./setup.sh --webjs --number=08xxxx
#
#   ./setup.sh --no-cron              # jangan pasang cron (dua mode)
#
# Aman dijalankan ulang: .env & groups.txt yang sudah ada gak ditimpa, cron gak dobel.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)

WEBJS=0 INSTALL_DOCKER=0 SKIP_COMPOSE=0 NO_CRON=0 PAIR_NUMBER=""
for arg in "$@"; do
  case $arg in
    --webjs) WEBJS=1 ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    --skip-compose) SKIP_COMPOSE=1 ;;
    --no-cron) NO_CRON=1 ;;
    --number=*) PAIR_NUMBER=${arg#*=} ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "opsi gak dikenal: $arg (lihat ./setup.sh --help)"; exit 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']$//g"; }
env_fill() { # isi KEY di .env kalau masih kosong; tambahkan kalau belum ada barisnya
  if ! grep -qE "^$1=" .env; then
    echo "$1=$2" >> .env
  elif grep -qE "^$1=$" .env; then
    sed -i.bak "s|^$1=$|$1=$2|" .env && rm -f .env.bak
  fi
}
install_cron() { # baris cron (tanpa marker) di argumen; blok lama untuk folder ini diganti
  local mark="# wa-group-recap $ROOT"
  {
    crontab -l 2>/dev/null | grep -vF "$ROOT/" | grep -vF "$mark" || true
    echo "$mark"
    printf '%s\n' "$@"
  } | crontab -
  crontab -l | grep -F "$ROOT/"
}

# ── Prasyarat ────────────────────────────────────────────────────
command -v python3 >/dev/null || die "python3 belum ada (apt install python3)"
python3 -c 'import zoneinfo' 2>/dev/null || die "butuh Python >= 3.9"
command -v curl >/dev/null || die "curl belum ada (apt install curl)"

if [ "$WEBJS" = 1 ]; then
  command -v node >/dev/null || die "Node.js belum ada (butuh >= 18): https://nodejs.org atau apt install nodejs npm"
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || die "butuh Node.js >= 18"
  command -v npm >/dev/null || die "npm belum ada"
elif [ "$SKIP_COMPOSE" = 0 ]; then
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
[ -f groups.txt ] || cp groups.example.txt groups.txt
mkdir -p output logs data

if [ "$WEBJS" = 1 ]; then
  # ── Mode WhatsApp Web ──────────────────────────────────────────
  if [ -z "$(env_get WEBJS_CHROME_PATH)" ]; then
    for c in chromium chromium-browser google-chrome google-chrome-stable; do
      if command -v "$c" >/dev/null; then env_fill WEBJS_CHROME_PATH "$(command -v "$c")"; break; fi
    done
  fi
  CHROME=$(env_get WEBJS_CHROME_PATH)
  say "Install whatsapp-web.js ${CHROME:+(pakai Chrome sistem: $CHROME)}"
  if [ -n "$CHROME" ]; then export PUPPETEER_SKIP_DOWNLOAD=true; fi
  (cd webjs && npm ci --omit=dev --no-audit --no-fund)
  if [ -z "$CHROME" ]; then
    # npm baru bisa melewati install script puppeteer; download Chrome-nya eksplisit
    say "Download Chrome untuk Puppeteer (gak ketemu Chrome/Chromium sistem)"
    (cd webjs && npx --yes puppeteer browsers install chrome) ||
      die "Gagal download Chrome. Install Chromium (apt install chromium) lalu isi WEBJS_CHROME_PATH di .env"
  fi

  say "Login WhatsApp Web"
  if [ -t 1 ]; then
    node webjs/recap.js login ${PAIR_NUMBER:+--number "$PAIR_NUMBER"} || true
  else
    echo "Terminal non-interaktif: jalankan sendiri 'node webjs/recap.js login' untuk scan QR."
  fi

  if [ "$NO_CRON" = 0 ]; then
    say "Pasang cron"
    EXPORT_CRON=$(env_get EXPORT_CRON)
    install_cron "${EXPORT_CRON:-0 5 * * *} cd $ROOT && $(command -v node) webjs/recap.js run >> $ROOT/logs/webjs.log 2>&1"
  fi
  NEXT_LINK="node webjs/recap.js login            (kalau belum tertaut)"
  NEXT_GROUPS="node webjs/recap.js groups"
  NEXT_TEST="node webjs/recap.js run --date \$(date +%F) --dry-run"
else
  # ── Mode Evolution ─────────────────────────────────────────────
  env_fill POSTGRES_PASSWORD "$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  env_fill EVOLUTION_API_KEY "$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  URL=$(env_get EVOLUTION_URL)
  if [ "$SKIP_COMPOSE" = 0 ]; then
    say "Nyalain Evolution + Postgres + Redis"
    docker compose up -d
  fi
  say "Nunggu Evolution siap di $URL"
  for _ in $(seq 1 60); do
    curl -fsS "$URL" >/dev/null 2>&1 && break
    sleep 3
  done
  curl -fsS "$URL" >/dev/null 2>&1 || die "Evolution gak respon. Cek: docker compose logs evolution"

  say "Siapin instance WhatsApp"
  CONNECT_ARGS=()
  [ -n "$PAIR_NUMBER" ] && CONNECT_ARGS+=(--number "$PAIR_NUMBER")
  [ -t 1 ] && CONNECT_ARGS+=(--wait)
  python3 recap/connect.py "${CONNECT_ARGS[@]+"${CONNECT_ARGS[@]}"}" || true

  if [ "$NO_CRON" = 0 ]; then
    say "Pasang cron"
    PY=$(command -v python3)
    EXPORT_CRON=$(env_get EXPORT_CRON)
    install_cron \
      "* * * * * $PY $ROOT/recap/cleanup.py >> $ROOT/logs/cleanup.log 2>&1" \
      "${EXPORT_CRON:-0 5 * * *} $PY $ROOT/recap/export.py >> $ROOT/logs/export.log 2>&1"
  fi
  NEXT_LINK="python3 recap/connect.py --status   (harus \"open\")"
  NEXT_GROUPS="python3 recap/groups.py"
  NEXT_TEST="python3 recap/export.py --date \$(date +%F) --dry-run"
fi

if [ "$NO_CRON" = 0 ]; then
  TZ_WANT=$(env_get TZ_NAME)
  TZ_HOST=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "?")
  if [ "$TZ_HOST" != "$TZ_WANT" ]; then
    echo "⚠️  Timezone server ($TZ_HOST) beda dengan TZ_NAME ($TZ_WANT); cron ikut jam server."
    echo "    Samakan: sudo timedatectl set-timezone $TZ_WANT"
  fi
fi

cat <<EOF

✓ Setup selesai. Langkah berikutnya:
  1. Pastikan WA tertaut:   $NEXT_LINK
  2. Pilih grup:            $NEXT_GROUPS  → salin baris ke groups.txt
  3. Isi .env:              RECIPIENTS, RECAP_API_URL (+ VERCEL_PROTECTION_BYPASS)
  4. Tes tanpa kirim:       $NEXT_TEST
  Rekap otomatis jalan sesuai EXPORT_CRON ($(env_get EXPORT_CRON)).
EOF
