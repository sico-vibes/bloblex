import sqlite3, sys
c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
print('AGENTS (name, colour, sort, archived, description):')
for r in c.execute('select name,color,sort_order,archived,description from agents order by runtime_id, sort_order'):
    print(' ', r)
print('agent.changed events:')
for r in c.execute("select sequence, json_extract(payload,'$.action'), substr(json_extract(payload,'$.agentId'),1,8), json_extract(payload,'$.archived') from app_events where type='agent.changed' order by sequence"):
    print(' ', r)
print('sessions -> agent:')
for r in c.execute('select s.id, s.title, a.name from sessions s left join agents a on a.id=s.agent_id order by s.created_at'):
    print(' ', r)
print('user_version:', c.execute('pragma user_version').fetchone()[0])
