import json
import os
import urllib.request

API_KEY = os.environ['DEEPLINE_API_KEY']

processed = set()
try:
    with open('processed-domains.txt') as f:
        processed = set(line.strip() for line in f if line.strip())
except FileNotFoundError:
    pass

query = """
SELECT company_name, normalized_domain, employee_count, industry, location
FROM companies
WHERE employee_count >= 10 AND employee_count <= 200
AND (
  industry ILIKE '%lead generation%' OR
  industry ILIKE '%marketing consulting%' OR
  industry ILIKE '%management consulting%' OR
  industry ILIKE '%sales consulting%' OR
  industry ILIKE '%business consulting%'
)
AND (
  location ILIKE '%united states%' OR
  location ILIKE '%united kingdom%' OR
  location ILIKE '%canada%' OR
  location ILIKE '%australia%'
)
AND normalized_domain IS NOT NULL
AND normalized_domain NOT IN ('facebook.com', 'google.com', 'amazon.com', 'instagram.com', 'linkedin.com', 'youtube.com')
LIMIT 300
"""

payload = json.dumps({"payload": {"sql": query}}).encode('utf-8')

req = urllib.request.Request(
    "https://code.deepline.com/api/v2/integrations/free_simple_company_search/execute",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    },
    method="POST"
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode('utf-8')
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode('utf-8')[:500]}")
    exit(1)

data = json.loads(raw)

def find_rows(obj, depth=0):
    if depth > 4: return None
    if isinstance(obj, list) and obj and isinstance(obj[0], dict): return obj
    if isinstance(obj, dict):
        for key in ['data', 'rows', 'result', 'results', 'records']:
            if key in obj:
                found = find_rows(obj[key], depth + 1)
                if found: return found
    return None

rows = find_rows(data) or []
print(f"Rows: {len(rows)}")

domains = []
for row in rows:
    if isinstance(row, dict):
        d = row.get('normalized_domain') or row.get('domain')
        if d and '.' in d and d not in processed:
            domains.append(d)

seen = set()
final = []
for d in domains:
    if d not in seen:
        seen.add(d)
        final.append(d)

final = final[:50]

with open('domains.txt', 'w') as f:
    for d in final:
        f.write(d + '\n')

print(f"Wrote {len(final)} fresh domains (skipped {len(processed)} already processed)")
for d in final[:20]:
    print(f"  {d}")
