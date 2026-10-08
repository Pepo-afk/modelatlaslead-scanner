import json
import os
import urllib.request

API_KEY = os.environ['DEEPLINE_API_KEY']

query = """
SELECT company_name, normalized_domain, employee_count, industry, location
FROM companies
WHERE employee_count >= 10 AND employee_count <= 200
AND (
  industry ILIKE '%marketing%' OR
  industry ILIKE '%advertising%' OR
  industry ILIKE '%sales%' OR
  industry ILIKE '%consulting%' OR
  industry ILIKE '%business services%'
)
AND (
  location ILIKE '%united states%' OR
  location ILIKE '%united kingdom%' OR
  location ILIKE '%canada%' OR
  location ILIKE '%australia%'
)
AND normalized_domain IS NOT NULL
LIMIT 150
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
    print(f"HTTP {e.code}: {e.reason}")
    print(e.read().decode('utf-8')[:1000])
    exit(1)
except Exception as e:
    print(f"Error: {e}")
    exit(1)

print("=== Raw response (first 1500 chars) ===")
print(raw[:1500])
print()

data = json.loads(raw)

# Find the rows array - try every possible shape
rows = []

def find_rows(obj, depth=0):
    if depth > 4:
        return None
    if isinstance(obj, list) and obj and isinstance(obj[0], dict):
        return obj
    if isinstance(obj, dict):
        for key in ['data', 'rows', 'result', 'results', 'records']:
            if key in obj:
                found = find_rows(obj[key], depth + 1)
                if found:
                    return found
    return None

rows = find_rows(data) or []

print(f"Rows parsed: {len(rows)}")
if rows:
    print(f"First row keys: {list(rows[0].keys())}")
    print(f"First row: {json.dumps(rows[0], indent=2)[:500]}")

domains = []
for row in rows:
    if isinstance(row, dict):
        d = row.get('normalized_domain') or row.get('domain')
        if d and '.' in d:
            domains.append(d)

seen = set()
final = []
for d in domains:
    if d not in seen:
        seen.add(d)
        final.append(d)

with open('domains.txt', 'w') as f:
    for d in final:
        f.write(d + '\n')

print(f"\nWrote {len(final)} unique domains to domains.txt")
for d in final[:20]:
    print(f"  {d}")
