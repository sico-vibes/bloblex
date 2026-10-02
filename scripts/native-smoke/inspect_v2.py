import sqlite3, sys, json, glob
db = sys.argv[1]
c = sqlite3.connect(db); c.row_factory = sqlite3.Row
print("user_version:", c.execute("PRAGMA user_version").fetchone()[0], "| ledger:", [tuple(r) for r in c.execute("SELECT version FROM schema_migrations")])
print("integrity:", c.execute("PRAGMA integrity_check").fetchone()[0], "| fk_check rows:", len(c.execute("PRAGMA foreign_key_check").fetchall()))
print("\nAGENTS:")
for r in c.execute("SELECT name,color,runtime_id,sort_order,archived,description,max_concurrency,length(instructions) as instr FROM agents ORDER BY runtime_id"): print(" ", dict(r))
print("\nSESSIONS -> agent:")
for r in c.execute("SELECT s.id, s.runtime_id, a.name AS agent, s.agent_id IS NULL AS agent_null FROM sessions s LEFT JOIN agents a ON a.id=s.agent_id ORDER BY s.id"): print(" ", dict(r))
print("\nUSAGE -> agent:")
for r in c.execute("SELECT u.id, u.session_id, a.name AS agent, u.agent_id IS NULL AS agent_null FROM usage_events u LEFT JOIN agents a ON a.id=u.agent_id ORDER BY u.id"): print(" ", dict(r))
print("\nrow counts:", {t: c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("sessions","turns","usage_events","runtimes","agents","app_events")})
for m in glob.glob(db.rsplit("\\",1)[0] + "\\backups\\*.manifest.json"):
    mj = json.load(open(m)); print("\nMANIFEST keys:", sorted(mj.keys()), "| integrity:", mj.get("integrity"), "| schemaVersion:", mj.get("schemaVersion"))
