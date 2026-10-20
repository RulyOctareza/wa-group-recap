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
- Kalau WhatsApp Web berubah dan skrip error: `npm install whatsapp-web.js@latest`.
- Tidak resmi: melanggar ToS WhatsApp. Pakai nomor khusus, jangan nomor pribadi; hindari kirim massal.
- Sudah diuji: format txt/pesan identik dengan versi repo, klien web summary, Chrome membuka
  WhatsApp Web, QR login, stop/timeout. **Belum** diuji dengan nomor tertaut sungguhan:
  coba `run --dry-run` dulu.
