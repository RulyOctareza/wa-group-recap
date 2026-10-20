# wa-group-recap

Rekap harian chat grup WhatsApp yang otomatis: pesan grup terpilih ditangkap di server,
dirangkum per hari jadi file txt, dikirim ke web summary, lalu hasil summary-nya
dikirim ke nomor WhatsApp tujuan.

> **Cuma butuh skrip?** [`standalone/wa-recap.js`](standalone/) = seluruh alur dalam satu file
> Node.js (WhatsApp Web, tanpa Docker/DB/Python).

```
 Grup WhatsApp                        Server (Docker)                               Web summary
┌──────────────┐  perangkat   ┌────────────────────────────────────┐   POST txt   ┌──────────────┐
│ Grup A, B, C │──tertaut────▶│ Evolution API ──▶ Postgres          │────────────▶│ RECAP_API_URL│
└──────────────┘  (Baileys)   │    │  (simpan semua pesan masuk)    │◀────────────│  (Vercel)    │
                              │    │                                 │   summary    └──────────────┘
                              │    ▼                                 │
                              │ cleanup.py   tiap menit: buang grup  │
                              │              non-target dari DB      │
                              │ export.py    05:00: DB → txt per grup│
                              │              → summary → kirim WA ───┼──▶ WA penerima (RECIPIENTS)
                              └────────────────────────────────────┘
```

## Dua mode tangkap

| | **Evolution** (default) | **WhatsApp Web** (`webjs/`, eksperimental) |
|---|---|---|
| Cara nyambung | Evolution API (Baileys): protokol WA Web ditiru, tanpa browser | whatsapp-web.js: **WhatsApp Web asli** di Chrome headless |
| Online | 24 jam | Hanya saat rekap (±5 menit/hari) |
| Penyimpanan | Postgres + Redis, cleanup tiap menit | Tidak ada DB; grup non-target tidak dibaca sama sekali |
| Server | Docker, ±190 MB RAM terus-menerus | Node ≥ 18 + Chrome, ±500 MB selama rekap saja |
| Kelemahan | Online terus = jejak lebih besar | Rawan rusak saat WhatsApp Web update (perbarui `whatsapp-web.js`) |

Keduanya tidak resmi dan sama-sama melanggar ToS WhatsApp; mode WhatsApp Web hanya
memperkecil jejak (klien resmi, online sebentar). Tahap txt → summary → kirim WA memakai
kode yang sama (`recap/export.py`). Setup mode WhatsApp Web: [lihat bawah](#mode-whatsapp-web).

## Cara kerja

| Tahap | Komponen | Detail |
|---|---|---|
| 1. Tangkap | Evolution API v2.3.7 | Server login ke WhatsApp sebagai **perangkat tertaut** (seperti WA Web). Semua pesan masuk disimpan ke tabel `Message` di Postgres (`DATABASE_SAVE_DATA_NEW_MESSAGE=true`, `groupsIgnore=false`). |
| 2. Saring | `recap/cleanup.py` (cron tiap menit) | Pesan dari grup yang **tidak** ada di `groups.txt` langsung dihapus; jumlahnya saja yang dicatat ke `wa_export.group_activity`. Pesan grup target dihapus setelah `DB_RETENTION_DAYS`. Chat pribadi tidak disentuh. |
| 3. Export | `recap/export.py` (cron `EXPORT_CRON`, default 05:00) | Ambil pesan kemarin 00:00–24:00 per grup → `output/<grup>/<grup>_<tanggal>.txt`. Format baris: `[08:15] Nama: isi pesan`, balasan diberi `↪ balas: "..."`, media jadi `[gambar] caption`, reaksi & pesan sistem dibuang. |
| 4. Summary | `recap/summarize.py` | Tiap txt di-POST ke `RECAP_API_URL`, teks summary diambil dari respons. Format request/response bisa diatur di `.env` → [docs/WEB_API.md](docs/WEB_API.md). |
| 5. Kirim | Evolution `sendText` / `sendMedia` | Ke setiap nomor di `RECIPIENTS`: ringkasan jumlah pesan + summary per grup (`SUMMARY_MODE`). Kalau summary suatu grup gagal, txt mentahnya dikirim sebagai cadangan. |

Contoh pesan yang diterima (`SUMMARY_MODE=per_group`):

```
📋 *Rekap Grup WA*
Minggu, 18 Okt 2026 (00:00-24:00 WIB)

• Grup A: 34 pesan
• Grup B: 4 pesan
• Grup C: 0 pesan

Total 38 pesan.
```
```
*Grup A* · 34 pesan

<teks summary dari web>
```

## Kebutuhan

| | Minimum | Rekomendasi |
|---|---|---|
| Server | 1 vCPU, 1 GB RAM + 1 GB swap, 10 GB disk | 2 vCPU, 2 GB RAM, 20 GB SSD |
| OS | Linux 64-bit (amd64 / arm64), Ubuntu 22.04+/Debian 12 | sama |
| Software | Docker + Compose v2, Python ≥ 3.9, cron | sama |
| Jaringan | Koneksi keluar ke WhatsApp; **tidak** perlu IP publik | sama |

Pemakaian terukur: Evolution ±150 MB, Postgres ±35 MB, Redis ±8 MB, CPU hampir nol saat idle.
Image Docker ±1,6 GB. VPS harus KVM (bukan OpenVZ/LXC).

**HP & nomor WhatsApp**
- Nomor yang dipakai harus **anggota grup** yang mau direkap.
- HP dengan WhatsApp aktif di nomor itu dibutuhkan untuk menautkan sekali (QR atau kode pairing).
  Sesudahnya HP boleh offline, tapi **wajib online minimal sekali tiap 14 hari**, kalau tidak
  WhatsApp otomatis me-logout semua perangkat tertaut. Praktisnya: HP Android cadangan standby
  di charger + WiFi.

## Setup

```bash
git clone <repo> wa-group-recap && cd wa-group-recap
./setup.sh --install-docker        # kalau Docker belum ada; logout-login, lalu:
./setup.sh                         # atau: ./setup.sh --number=08xxxxxxxxxx (kode pairing)
```

`setup.sh` akan: membuat `.env` (API key & password DB di-generate), menyalakan
Evolution + Postgres + Redis, membuat instance WhatsApp dengan `groupsIgnore=false`,
menampilkan QR / kode pairing, dan memasang cron. Aman dijalankan ulang.

Lalu:

1. **Tautkan HP**: WhatsApp → Perangkat tertaut → Tautkan perangkat.
   - QR: tampil di terminal kalau `qrencode` terpasang, atau lewat Evolution Manager:
     `ssh -L 8085:localhost:8085 user@server` → buka `http://localhost:8085/manager`.
   - Tanpa kamera: `python3 recap/connect.py --number 08xxxxxxxxxx` → pilih
     "Tautkan dengan nomor telepon saja" di HP → masukkan kode.
   - Cek: `python3 recap/connect.py --status` → harus `open`.
2. **Pilih grup**: `python3 recap/groups.py` → salin baris grup yang diinginkan ke `groups.txt`.
   Mode ini menampilkan grup yang **sudah ada pesannya** sejak WA ditautkan, urut paling ramai.
   Nama diambil dari cache Evolution; yang belum ada di cache diambil dari WhatsApp satu grup
   tiap 3 detik (`--no-fetch` = tanpa request ke WhatsApp sama sekali). Biarkan WA tertaut
   beberapa jam dulu supaya daftarnya lengkap.
   `--all` menarik semua grup langsung dari WhatsApp (1 request + 1 foto profil per grup);
   **jangan dipakai 15–30 menit pertama setelah menautkan**, karena saat itu Evolution sedang
   sinkron metadata grup dan WhatsApp membalas `rate-overlimit`.
3. **Isi `.env`**: `RECIPIENTS`, `RECAP_API_URL`, dan kalau web di Vercel memakai
   Deployment Protection: `VERCEL_PROTECTION_BYPASS`.
4. **Tes**: `python3 recap/export.py --date $(date +%F) --dry-run` (semua tahap jalan,
   pesan WA cuma dicetak), lalu `--to 08xxxx` untuk kirim sungguhan ke satu nomor.

Server memakai jam lokal untuk cron. Samakan timezone dengan `TZ_NAME`:
`sudo timedatectl set-timezone Asia/Jakarta`.

### Memakai Evolution yang sudah ada

Kalau server sudah menjalankan Evolution API lain, lewati stack bawaan:
isi `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `INSTANCE`, `PG_CONTAINER`, `PG_USER`, `PG_DB`,
`REDIS_CONTAINER`, `REDIS_DB`, `REDIS_PREFIX` di `.env`, lalu `./setup.sh --skip-compose`. Instance itu akan diubah ke `groupsIgnore=false`;
pastikan aplikasi lain yang memakai instance tersebut aman menerima pesan grup.

## Mode WhatsApp Web

> **Eksperimental.** Sudah diuji: instalasi, Chrome membuka WhatsApp Web, QR login, penanganan
> stop/timeout, dan tahap txt → summary → pesan WA. **Belum** diuji dengan nomor tertaut
> sungguhan (pengambilan pesan grup & pengiriman); uji dulu dengan `--dry-run` dan `--to`.

Tanpa Docker/Postgres/Redis. Butuh Node.js ≥ 18 dan Chrome/Chromium (`apt install chromium`;
kalau tidak ada, `setup.sh` mengunduh Chrome bawaan Puppeteer, khusus x86_64).

```bash
./setup.sh --webjs                       # npm install, login (QR), cron harian
./setup.sh --webjs --number=08xxxxxxxx   # login pakai kode pairing
```

| Perintah | Fungsi |
|---|---|
| `node webjs/recap.js login [--number 08xx]` | Tautkan HP. Sesi disimpan di `WEBJS_SESSION_DIR` (default `data/webjs-session`). |
| `node webjs/recap.js groups` | Daftar grup dari store lokal WA Web (tanpa request per grup), urut terakhir aktif. Format `groups.txt`. |
| `node webjs/recap.js run [--date D] [--dry-run] [--no-summary] [--to 08xx]` | Rekap harian: buka Chrome → tunggu pesan tertunda masuk → ambil pesan grup target hari itu → `recap/export.py --raw` (txt + summary) → kirim lewat sesi yang sama → tutup Chrome. |

Cara kerja `run`: WhatsApp menyimpan pesan untuk perangkat tertaut yang sedang offline dan
mengirimkannya saat perangkat itu tersambung lagi. Setelah WA Web terbuka, skrip menunggu
sampai tidak ada pesan baru selama `WEBJS_SYNC_QUIET` detik (maks `WEBJS_SYNC_MAX_WAIT`),
lalu membaca pesan grup lewat `fetchMessages` (memuat pesan lama sampai melewati 00:00).
`WEBJS_MAX_RUNTIME` (default 20 menit) menutup Chrome paksa kalau ada yang macet.

Catatan mode ini:
- Jalankan `run` minimal sekali sehari (cron). Perangkat tertaut yang lama tidak tersambung
  bisa di-logout WhatsApp, dan HP utama tetap wajib online tiap 14 hari.
- Jangan jalankan dua perintah `webjs/recap.js` bersamaan: profil Chrome-nya terkunci.
- Kalau WhatsApp Web berubah dan skrip error: `cd webjs && npm install whatsapp-web.js@latest`.

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `EVOLUTION_API_KEY`, `POSTGRES_PASSWORD` | (generate) | Diisi `setup.sh`. API key = akses penuh ke WhatsApp. |
| `EVOLUTION_PORT` / `EVOLUTION_URL` | `8085` | Evolution hanya di-bind ke `127.0.0.1`. |
| `INSTANCE` | `recap` | Nama instance WhatsApp. |
| `PG_CONTAINER`, `PG_USER`, `PG_DB` | `wa-recap-postgres`, `evolution`, `evolution` | Postgres yang di-query script. |
| `REDIS_CONTAINER`, `REDIS_DB`, `REDIS_PREFIX` | `wa-recap-redis`, `1`, `wa_recap` | Cache Redis Evolution, dibaca `groups.py` untuk nama grup. Untuk Evolution lain: samakan dengan `CACHE_REDIS_URI` / `CACHE_REDIS_PREFIX_KEY`-nya. |
| `TZ_NAME` | `Asia/Jakarta` | Batas hari rekap. |
| `EXPORT_CRON` | `0 5 * * *` | Jadwal rekap (jam server). Jalankan ulang `setup.sh` setelah diubah. |
| `RECIPIENTS` | — | Nomor penerima, `08xx`/`62xx`, pisah koma. |
| `SUMMARY_MODE` | `per_group` | `per_group` = ringkasan + 1 pesan per grup; `combined` = 1 pesan. |
| `SEND_TXT` | `false` | Ikut kirim file txt mentah. Txt selalu dikirim kalau summary gagal. |
| `DB_RETENTION_DAYS` | `7` | Lama pesan grup target disimpan di DB (bisa export ulang). |
| `TXT_RETENTION_DAYS` | `30` | Lama file txt disimpan di `output/`. |
| `RECAP_API_*`, `VERCEL_PROTECTION_BYPASS` | — | Lihat [docs/WEB_API.md](docs/WEB_API.md). Kosongkan `RECAP_API_URL` untuk melewati summary. |

## Operasional

```bash
python3 recap/connect.py --status                 # status WA (open / connecting / close)
python3 recap/export.py --date 2026-10-18         # export + kirim ulang tanggal tertentu
python3 recap/export.py --date 2026-10-18 --dry-run --no-summary
tail -f logs/export.log logs/cleanup.log          # log cron (cleanup.log hanya berisi error)
docker compose logs -f evolution                  # log WhatsApp
docker compose pull && docker compose up -d       # setelah mengganti versi image
```

- **Tambah/hapus grup**: edit `groups.txt`. Berlaku untuk pesan yang masuk sesudahnya;
  pesan grup yang tadinya non-target sudah terhapus.
- **Ganti penerima**: edit `RECIPIENTS`, tidak perlu restart.
- **Backup**: `docker compose exec postgres pg_dump -U evolution evolution > backup.sql`.
  Sesi WhatsApp tersimpan di Postgres + `data/evolution`; kalau hilang, cukup tautkan ulang.

## Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| Rekap berisi peringatan "Semua grup 0 pesan" | WA tidak connected seharian. `connect.py --status`; kalau `close`, tautkan ulang. |
| "Gak ada pesan dari anggota lain" | Server cuma menerima pesan dari HP sendiri. Kirim pesan uji ke grup dari nomor lain; kalau tidak masuk, logout perangkat tertaut di HP lalu tautkan ulang. |
| Instance reconnect terus / gagal connect | ISP me-reset koneksi ke IP Meta tertentu → aktifkan `extra_hosts` di `docker-compose.yml`. |
| Ter-logout sendiri | HP utama tidak online lebih dari 14 hari. |
| `groups.py --all` timeout, log Evolution penuh `rate-overlimit` | Normal tepat setelah menautkan / reconnect: Evolution menarik metadata tiap grup yang ada pesannya dan WhatsApp membatasi laju. Jangan di-retry terus; tunggu 15–30 menit sampai `docker logs --since 2m wa-recap-evolution 2>&1 \| grep -c rate-overlimit` jadi 0. Pakai `groups.py` tanpa `--all`. |
| WhatsApp Web: `Sesi WA belum ditautkan atau sudah logout` | Sesi hilang/di-logout dari HP → `node webjs/recap.js login`. |
| WhatsApp Web: `melewati WEBJS_MAX_RUNTIME` / Chrome gagal start | Cek `logs/webjs.log`; pastikan tidak ada `webjs/recap.js` lain yang jalan; perbarui `whatsapp-web.js`. |
| `Summary gagal: dapat halaman HTML ...` | Web kena Vercel Deployment Protection → isi `VERCEL_PROTECTION_BYPASS`. |
| `Summary gagal: HTTP 4xx` | Format request tidak sesuai web → cocokkan `RECAP_API_MODE` / nama field ([docs/WEB_API.md](docs/WEB_API.md)). |
| Pesan grup dari orang lain gagal didekripsi (`No session found to decrypt message`) | Bug Evolution 2.3.7 di grup ber-alamat LID ([#2755](https://github.com/evolution-foundation/evolution-api/issues/2755)). Tautkan ulang; kalau berlanjut, uji versi Evolution yang lebih baru. |

## Keamanan & privasi

- Evolution API **tidak resmi** (Baileys, protokol WhatsApp Web yang di-reverse-engineer) dan
  melanggar ToS WhatsApp. Risiko blokir terutama untuk spam/kirim massal; pemakaian baca +
  kirim beberapa pesan per hari berisiko rendah, tapi bukan nol. Pakai nomor yang siap risiko.
- `EVOLUTION_API_KEY` memberi akses membaca semua chat dan mengirim pesan atas nama nomor itu.
  Port Evolution hanya di `127.0.0.1`; jangan dibuka ke internet / tunnel publik.
- DB dan `output/` berisi pesan anggota grup. Batasi akses server; retensi default 7 hari (DB)
  dan 30 hari (txt).
- `.env`, `groups.txt`, `data/`, `output/`, `logs/` tidak di-commit (`.gitignore`).

## Batasan

- Hanya pesan yang masuk **setelah** nomor ditautkan dan selama server online yang tertangkap.
  Tidak ada riwayat lama.
- Teks saja: media ditulis sebagai placeholder (`[gambar] caption`, `[voice note]`).
- Satu instance = satu nomor WhatsApp. Nomor tambahan butuh instance + `.env` terpisah.

## Struktur repo

```
docker-compose.yml   Evolution API + Postgres + Redis
setup.sh             installer sekali jalan (idempotent)
.env.example         semua konfigurasi
groups.example.txt   contoh daftar grup target
recap/common.py      config, query DB, Evolution API
recap/connect.py     buat instance, settings, QR / kode pairing
recap/groups.py      daftar grup (cache Evolution / --all) + aktivitas 7 hari
recap/cleanup.py     buang pesan grup non-target (cron tiap menit)
recap/export.py      DB → txt → summary → kirim WA (cron harian)
recap/summarize.py   klien web summary
webjs/recap.js       mode WhatsApp Web: login, groups, run (whatsapp-web.js)
standalone/          versi satu skrip (wa-recap.js), tanpa Docker/DB/Python
docs/WEB_API.md      kontrak request/response web summary
```

## Lisensi pihak ketiga

Proyek ini memakai [Evolution API](https://github.com/evolution-foundation/evolution-api)
(Apache 2.0 dengan syarat tambahan: penggunaan Evolution API harus disebutkan di
dokumentasi sistem, dan logo/hak cipta di konsolnya tidak boleh dihapus).
