#!/usr/bin/env python3
# Seed xmrt_university_courses from curriculum.json (extracted from the served build)
import json, urllib.request, urllib.error

REST = 'http://127.0.0.1:54321/rest/v1/xmrt_university_courses'
KEY = 'local-anon-key'

def rest(method, path, payload=None):
    body = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(REST + path, data=body, method=method,
        headers={"Content-Type":"application/json","apikey":KEY,"Authorization":f"Bearer {KEY}","Prefer":"return=minimal"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

cur = json.load(open(r'C:\Users\PureTrek\AppData\Local\Temp\curriculum.json'))
print("seeding", len(cur), "modules")

# clear existing (idempotent re-seed)
rest('DELETE', '?module_number=gte.1')

ok = 0
for m in cur:
    payload = {
        "module_number": m['module'],
        "title": m['title'],
        "description": m.get('description',''),
        "content": "# Module %d: %s" % (m['module'], m['title']),
        "quiz_questions": json.dumps(m.get('quiz', [])),
        "trap_questions": json.dumps(m.get('traps', [])),
        "passing_score": m.get('passing_score', 80),
        "required": True,
        "order_index": m['module'],
    }
    st, body = rest('POST', '', payload)
    if st in (200,201):
        ok += 1
    else:
        print("  FAIL module", m['module'], st, body[:120])
print("Inserted", ok, "of", len(cur))
