import sqlite3, sys
p = sys.argv[1]
c = sqlite3.connect(p)
c.execute("PRAGMA foreign_keys=OFF")
now = "2026-10-01T20:00:00.000Z"
sessions = [
 ("s-codex-1","rt_codex_3f3b386c","codex","C:/work/korus","Invoice parser tests","idle"),
 ("s-codex-2","rt_codex_3f3b386c","codex","C:/work/korus","Fix locale parsing","idle"),
 ("s-claude-1","rt_claude_2fd4acf3","claude","C:/work/site","Hero copy","idle"),
 ("s-orphan","rt_gone_runtime","codex","C:/work/old","Session whose runtime row vanished","offline"),
]
for sid, rt, prov, proj, title, state in sessions:
    c.execute("INSERT INTO sessions(id,runtime_id,provider,project_path,title,state,resumable,created_at,updated_at,data) VALUES(?,?,?,?,?,?,0,?,?,'{}')",(sid,rt,prov,proj,title,state,now,now))
    c.execute("INSERT INTO turns(id,session_id,state,created_at,completed_at,data) VALUES(?,?,?,?,?,'{}')",("t-"+sid,sid,"completed",now,now))
usage = [
 ("u1","rt_codex_3f3b386c","s-codex-1","t-s-codex-1","codex","gpt-6-luna",1200,300),
 ("u2","rt_claude_2fd4acf3","s-claude-1","t-s-claude-1","claude","claude-opus-5-5",800,200),
 ("u3","rt_gone_runtime","s-orphan","t-s-orphan","codex","gpt-6-luna",50,10),
 ("u4","rt_codex_3f3b386c","s-missing-session","t-none","codex","gpt-6-luna",10,5),
]
for uid, rt, sid, tid, prov, model, i, o in usage:
    c.execute("INSERT INTO usage_events(id,runtime_id,session_id,turn_id,provider,model,timestamp,input_tokens,output_tokens,source,raw) VALUES(?,?,?,?,?,?,?,?,?,'seed','{}')",(uid,rt,sid,tid,prov,model,now,i,o))
c.commit()
print("seeded:", c.execute("select count(*) from sessions").fetchone()[0], "sessions;", c.execute("select count(*) from usage_events").fetchone()[0], "usage rows")
print("integrity:", c.execute("PRAGMA integrity_check").fetchone()[0])
