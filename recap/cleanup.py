#!/usr/bin/env python3
"""Hapus pesan grup non-target dari DB Evolution. Jalan tiap menit via cron.

- Pesan grup yang gak ada di groups.txt langsung dihapus. Jumlahnya dicatat per
  grup per hari ke wa_export.group_activity (buat lihat grup mana yang aktif).
- Pesan grup target dihapus setelah lewat DB_RETENTION_DAYS.
- Chat pribadi gak disentuh.
"""
import time

from common import SCHEMA_SQL, load_env, load_groups, psql, sql_list, timezone


def main() -> None:
    env = load_env()
    tz_name, _, _ = timezone(env)
    targets = sql_list(load_groups())
    cutoff = int(time.time()) - int(env.get('DB_RETENTION_DAYS', '7')) * 86400
    psql(SCHEMA_SQL + f"""
with del as (
  delete from "Message"
  where key->>'remoteJid' like '%@g.us'
    and (key->>'remoteJid' not in ({targets}) or "messageTimestamp" < {cutoff})
  returning key->>'remoteJid' as jid, "messageTimestamp" as ts
)
insert into wa_export.group_activity (jid, day, msgs)
select jid, (to_timestamp(ts) at time zone '{tz_name}')::date, count(*)
from del
where jid not in ({targets})
group by 1, 2
on conflict (jid, day) do update
  set msgs = wa_export.group_activity.msgs + excluded.msgs;
""", env)


if __name__ == '__main__':
    main()
