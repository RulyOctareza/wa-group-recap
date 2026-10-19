#!/usr/bin/env python3
"""Daftar grup yang diikuti nomor WA, buat ngisi groups.txt.

  recap/groups.py              # grup aktif: cache Evolution + DB, nama yang kosong diisi pelan-pelan
  recap/groups.py --no-fetch   # sama, tapi TANPA request ke WhatsApp sama sekali
  recap/groups.py --all        # semua grup, ditarik langsung dari WhatsApp (berat, lihat bawah)

Tiap baris berformat groups.txt (`jid|Nama  # info`), tinggal salin ke groups.txt.

Mode default menampilkan grup yang sudah ada pesannya sejak WA ditautkan. Nama diambil
dari cache metadata grup Evolution di Redis; grup yang belum ada di cache (biasanya karena
pengambilan metadatanya kena rate limit) diisi lewat findGroupInfos, satu grup tiap 3 detik,
berhenti di error pertama.

--all memanggil fetchAllGroups: 1 request daftar grup + 1 request foto profil PER GRUP.
Tepat setelah nomor baru ditautkan, Evolution sedang menarik metadata grup dan WhatsApp
membalas `rate-overlimit`; --all akan lambat/timeout. Tunggu 15-30 menit dulu, jangan di-loop.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse

from common import SCHEMA_SQL, api, load_env, load_groups, psql

PREFIX_RE = re.compile(r'^[A-Za-z0-9_-]+$')


def activity(env: dict) -> dict[str, int]:
    """Jumlah pesan per grup 7 hari terakhir (target dari tabel Message, non-target dari statistik)."""
    out = psql(SCHEMA_SQL + """
select coalesce(json_object_agg(jid, n), '{}') from (
  select jid, sum(n)::int as n from (
    select jid, sum(msgs) as n from wa_export.group_activity
    where day > current_date - 7 group by 1
    union all
    select key->>'remoteJid', count(*) from "Message"
    where key->>'remoteJid' like '%@g.us'
      and "messageTimestamp" > extract(epoch from now() - interval '7 days')
    group by 1
  ) t group by jid
) s;
""", env)
    return json.loads(out or '{}')


def cached_groups(env: dict) -> list[dict]:
    """Metadata grup dari cache Redis Evolution (key `<prefix>:groups:<jid>`)."""
    prefix = env.get('REDIS_PREFIX', 'wa_recap')
    if not PREFIX_RE.match(prefix):
        raise ValueError(f'REDIS_PREFIX gak valid: {prefix!r}')
    cli = ['docker', 'exec', '-i', env.get('REDIS_CONTAINER', 'wa-recap-redis'),
           'redis-cli', '-n', env.get('REDIS_DB', '1')]
    keys = subprocess.run(cli + ['--scan', '--pattern', f'{prefix}:groups:*'],
                          capture_output=True, text=True, timeout=60, check=True).stdout.split()
    if not keys:
        return []
    values = subprocess.run(cli, input='MGET ' + ' '.join(keys) + '\n',
                            capture_output=True, text=True, timeout=60, check=True).stdout
    groups = []
    for line in values.splitlines():
        try:
            meta = json.loads(line).get('data') or {}
        except (ValueError, AttributeError):
            continue
        if meta.get('id'):
            groups.append({'id': meta['id'], 'subject': meta.get('subject'),
                           'size': meta.get('size') or len(meta.get('participants') or [])})
    return groups


def fill_names(env: dict, groups: list[dict], limit: int = 30, gap: int = 3) -> None:
    """Isi nama grup yang gak ada di cache. Tiap grup = 2 request WhatsApp (metadata + foto)."""
    missing = [g for g in groups if g['subject'] == '?'][:limit]
    if not missing:
        return
    print(f'Ngambil nama {len(missing)} grup dari WhatsApp, 1 grup tiap {gap} detik...', file=sys.stderr)
    for i, g in enumerate(missing):
        if i:
            time.sleep(gap)
        path = f"/group/findGroupInfos/{env['INSTANCE']}?groupJid={urllib.parse.quote(g['id'])}"
        try:
            info = api(env, 'GET', path, timeout=30) or {}
        except (TimeoutError, urllib.error.URLError) as exc:
            print(f'Berhenti ngisi nama ({exc}). WhatsApp mungkin lagi rate limit; '
                  'jalankan ulang 15-30 menit lagi.', file=sys.stderr)
            return
        g['subject'] = info.get('subject') or '?'
        g['size'] = info.get('size') or g['size']


def all_groups(env: dict, timeout: int) -> list[dict]:
    try:
        return api(env, 'GET', f"/group/fetchAllGroups/{env['INSTANCE']}?getParticipants=false",
                   timeout=timeout) or []
    except (TimeoutError, urllib.error.URLError) as exc:
        sys.exit(f'Gagal narik daftar grup dari WhatsApp ({exc}).\n'
                 'Kalau nomor baru ditautkan, Evolution masih kena rate limit WhatsApp: tunggu '
                 '15-30 menit lalu coba sekali lagi. Atau pakai `recap/groups.py` tanpa --all '
                 '(baca cache, tanpa request ke WhatsApp).')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--all', action='store_true', help='semua grup, langsung dari WhatsApp')
    parser.add_argument('--no-fetch', action='store_true', help='jangan request ke WhatsApp, cache saja')
    parser.add_argument('--timeout', type=int, default=300, help='timeout --all dalam detik (default 300)')
    args = parser.parse_args()

    env = load_env()
    try:
        targets = {jid for jid, _ in load_groups()}
    except FileNotFoundError:
        targets = set()
    counts = activity(env)

    if args.all:
        print('Narik semua grup dari WhatsApp (1 request + 1 per grup), bisa beberapa menit...',
              file=sys.stderr)
        groups = all_groups(env, args.timeout)
    else:
        groups = cached_groups(env)
        known = {g['id'] for g in groups}
        # Grup yang ada pesannya tapi cache-nya udah kedaluwarsa: tampilkan tanpa nama
        groups += [{'id': jid, 'subject': '?', 'size': None} for jid in counts if jid not in known]
        if not groups:
            print('Belum ada grup di cache: belum ada pesan grup yang masuk sejak WA ditautkan.\n'
                  'Tunggu ada obrolan di grup, atau pakai --all (hindari 15-30 menit pertama '
                  'setelah nautin).', file=sys.stderr)
            return
        if not args.no_fetch:
            fill_names(env, groups)

    for g in sorted(groups, key=lambda g: (counts.get(g['id'], 0), g.get('size') or 0), reverse=True):
        info = f"{g.get('size') or '?'} anggota, {counts.get(g['id'], 0)} pesan/7 hari"
        if g['id'] in targets:
            info += ', TARGET'
        print(f"{g['id']}|{(g.get('subject') or '').strip()}  # {info}")


if __name__ == '__main__':
    main()
