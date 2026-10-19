# Kontrak web summary

`recap/summarize.py` mengirim **satu request per grup per hari** ke `RECAP_API_URL`
dan memakai teks dari respons sebagai summary. Bentuk request & respons diatur di `.env`,
jadi web yang berbeda cukup disesuaikan konfigurasinya tanpa mengubah kode.

## Request

Selalu `POST`. Header tambahan:

| Header | Kapan |
|---|---|
| `x-vercel-protection-bypass: <VERCEL_PROTECTION_BYPASS>` | kalau diisi |
| `Authorization: Bearer <RECAP_API_TOKEN>` | kalau diisi |
| `Accept: application/json, text/plain;q=0.9` | selalu |

### `RECAP_API_MODE=multipart` (default)

`multipart/form-data` dengan field:

| Field (nama diatur di .env) | Isi |
|---|---|
| `RECAP_API_FILE_FIELD` (default `file`) | file txt, `Content-Type: text/plain; charset=utf-8`, nama `<Grup>_<YYYY-MM-DD>.txt` |
| `RECAP_API_PASSWORD_FIELD` (default `password`) | `RECAP_API_PASSWORD` (boleh kosong). Kosongkan nama field-nya untuk tidak mengirim field ini. |

Setara dengan:

```bash
curl -X POST "$RECAP_API_URL" \
  -H "x-vercel-protection-bypass: $VERCEL_PROTECTION_BYPASS" \
  -F "file=@output/Grup-A/Grup-A_2026-10-18.txt;type=text/plain" \
  -F "password="
```

### `RECAP_API_MODE=json`

```json
{ "text": "<isi txt>", "password": "" }
```

Nama key mengikuti `RECAP_API_TEXT_FIELD` dan `RECAP_API_PASSWORD_FIELD`.

## Respons

| Content-Type | Yang diambil |
|---|---|
| `application/json` | nilai di `RECAP_API_RESULT_PATH` (dot path; default `summary`; contoh `data.result` atau `choices.0.text`). Kalau nilainya bukan string, dikirim sebagai JSON terformat. |
| `text/plain` / lainnya | seluruh body |
| `text/html` | dianggap **gagal** (biasanya halaman login Vercel atau halaman error) |

Contoh respons yang cocok dengan default:

```json
{ "summary": "Hari ini grup membahas jadwal kajian Jumat ..." }
```

Summary dikirim ke WhatsApp apa adanya. WhatsApp mendukung `*tebal*`, `_miring_`,
`~coret~`, dan daftar `- item`; markdown lain (judul `#`, tabel) tampil sebagai teks biasa.

## Error & retry

- Timeout `RECAP_API_TIMEOUT` detik (default 180) per percobaan.
- HTTP 5xx, 429, timeout, dan error jaringan dicoba ulang sampai 3 kali (jeda 15 s, 30 s).
- HTTP 4xx lain, respons HTML, atau field summary tidak ditemukan langsung dianggap gagal.
- Kalau gagal, txt mentah grup itu dikirim ke WhatsApp dengan catatan "summary gagal",
  sehingga rekap tetap sampai.

## Vercel Deployment Protection

Deployment Vercel yang diproteksi (Vercel Authentication) mengalihkan request dari server
ke halaman login. Untuk akses mesin-ke-mesin:

1. Di project Vercel: **Settings → Deployment Protection → Protection Bypass for Automation**
   → generate secret.
2. Isi `VERCEL_PROTECTION_BYPASS=<secret>` di `.env` server.

Proteksi tetap aktif untuk pengunjung lain. Simpan secret seperti password (`.env` chmod 600)
dan rotasi kalau bocor.

## Uji tanpa web asli

```bash
python3 recap/export.py --date 2026-10-18 --dry-run    # pakai RECAP_API_URL dari .env
python3 recap/export.py --date 2026-10-18 --dry-run --no-summary
```
