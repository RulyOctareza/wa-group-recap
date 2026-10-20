# wa-recap.js — versi satu skrip

Seluruh alur dalam satu file Node.js, tanpa Docker/Postgres/Python:
WhatsApp Web asli (whatsapp-web.js + Chrome headless) dibuka cuma saat rekap →
ambil pesan grup kemarin → txt per grup → POST ke web summary → kirim hasilnya ke WhatsApp.
Format txt & pesan sama dengan versi repo utama.

## Pakai

```bash
npm install                                 # Node >= 18; folder ini berisi package.json
# isi CONFIG di bagian atas wa-recap.js (groups, recipients, api.url, ...)
node wa-recap.js login                      # scan QR, atau: login --number 08xxxxxxxxxx
node wa-recap.js groups                     # daftar grup → salin baris ke CONFIG.groups
node wa-recap.js run --date 2026-10-18 --dry-run   # tes tanpa kirim
node wa-recap.js run --to 08xxxxxxxxxx      # tes kirim ke satu nomor
```

Cron harian (jam server):

```
0 5 * * * cd /folder/skrip && node wa-recap.js run >> wa-recap.log 2>&1
```

## Catatan

- Server Linux: isi `CONFIG.whatsapp.chromePath` dengan Chromium sistem (`/usr/bin/chromium`),
  lalu install dengan `PUPPETEER_SKIP_DOWNLOAD=true npm install`. Tanpa Chromium sistem,
  Puppeteer memakai Chrome bawaannya (x86_64); kalau npm melewati download-nya:
  `npx puppeteer browsers install chrome`.
- Rahasia web summary bisa lewat env: `VERCEL_PROTECTION_BYPASS`, `RECAP_API_TOKEN`.
- Sesi login tersimpan di `wa-session/`; jangan dibagi. Hapus folder itu untuk logout.
- Nomor yang ditautkan harus anggota grup; HP utama wajib online minimal sekali per 14 hari.
- Jalankan `run` tiap hari (cron); jangan jalankan dua perintah bersamaan (profil Chrome terkunci).
- `maxRuntimeSec` (default 20 menit) menutup Chrome paksa kalau ada yang macet.
- whatsapp-web.js dikunci ke commit `main` resmi `064a3d5` (URL tarball di `package.json`),
  karena rilis 1.34.7 rusak di WA Web terbaru. Kalau WhatsApp Web berubah lagi dan skrip error:
  cek commit/rilis terbaru di github.com/wwebjs/whatsapp-web.js, ganti URL-nya, `npm install`.
- Tidak resmi: melanggar ToS WhatsApp. Pakai nomor khusus, jangan nomor pribadi; hindari kirim massal.
- **Status uji (20 Okt 2026, nomor tertaut sungguhan, WA Web 2.3000.1050912399):**
  - `login` (QR), `groups` (146 grup, ±7 detik), `run` (±35 detik): 21 dari 22 pesan 19 Okt cocok
    dengan Evolution (selisihnya 1 gambar yang dikirim sebelum perangkat ditautkan).
  - Dengan whatsapp-web.js `main` (064a3d5): kirim dokumen txt OK, buka WA Web lebih stabil.
    Skrip tetap menambal `MsgKey._serialized` → `$1` dan mengalihkan dokumen yang gagal jadi
    pesan teks, untuk jaga-jaga.
  - WA Web kadang nyangkut setelah login (`ready` gak muncul). Skrip membuka ulang Chrome
    (maks 3x); saat diuji dengan buka-tutup berulang dalam waktu singkat kejadiannya sering,
    untuk 1x sehari diperkirakan jarang. Pantau `wa-recap.log`.
