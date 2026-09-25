# Read-only look at ~/.codex/queue_1.sqlite: schema and row counts (no message bodies printed).
import sqlite3, os, pathlib
p = pathlib.Path(os.path.expanduser('~/.codex/queue_1.sqlite')).as_posix()
c = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
for n, s in c.execute("select name, sql from sqlite_master where type in ('table','index')"):
    print(n, '::', (s or '')[:600].replace('\n', ' '))
for (t,) in c.execute("select name from sqlite_master where type='table'").fetchall():
    try:
        print(t, 'rows =', c.execute(f'select count(*) from "{t}"').fetchone()[0])
    except Exception as e:
        print(t, e)
