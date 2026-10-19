#!/usr/bin/env python3
"""Daftar grup yang diikuti nomor WA, buat ngisi groups.txt.

  recap/groups.py            # semua grup, urut anggota terbanyak
  recap/groups.py --active   # urut jumlah pesan 7 hari terakhir

Tiap baris berformat groups.txt (`jid|Nama  # info`), tinggal salin ke groups.txt.
Angka --active baru terisi setelah cleanup.py jalan beberapa hari (grup non-target
cuma dihitung, isinya dibuang).
"""
from __future__ import annotations

import argparse
import json

from common import SCHEMA_SQL, api, load_env, load_groups, psql


def activity(env: dict) -> dict[str, int]:
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--active', action='store_true', help='urut berdasarkan pesan 7 hari terakhir')
    args = parser.parse_args()

    env = load_env()
    groups = api(env, 'GET', f"/group/fetchAllGroups/{env['INSTANCE']}?getParticipants=false") or []
    try:
        targets = {jid for jid, _ in load_groups()}
    except FileNotFoundError:
        targets = set()
    counts = activity(env) if args.active else {}

    key = (lambda g: counts.get(g['id'], 0)) if args.active else (lambda g: g.get('size') or 0)
    for g in sorted(groups, key=key, reverse=True):
        info = f"{g.get('size') or '?'} anggota"
        if args.active:
            info += f", {counts.get(g['id'], 0)} pesan/7 hari"
        if g['id'] in targets:
            info += ', TARGET'
        print(f"{g['id']}|{(g.get('subject') or '').strip()}  # {info}")


if __name__ == '__main__':
    main()
