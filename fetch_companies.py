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

payload = json.dumps({"sql": query}).encode('utf-8')

req = urllib.request.Request(
    "https://code.deepline.com/api/v2/tools/execute",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    },
    method="POST"
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode('utf-8'))
except Exception as e:
    print(f"HTTP error: {e}")
    exit(1)

print("Response top-level keys:", list(data.keys()) if isinstance(data, dict) else type(data).__name__)

rows = []
if isinstance(data, dict):
    for key in ['data', 'rows', 'result', 'results']:
        if key in data and isinstance(data[key], list):
            rows = data[key]
            break
    if not rows and 'data' in data and isinstance(data['data'], dict):
        for key in ['data', 'rows', 'result']:
            if key in data['data'] and isinstance(data['data'][key], list):
                rows = data['data'][key]
                break

if not rows and isinstance(data, list):
    rows = data

print(f"Rows returned: {len(rows)}")
if rows:
    print("First row keys:", list(rows[0].keys()))

domains = []
for row in rows:
    if isinstance(row, dict):
        d = row.get('normalized_domain') or row.get('domain')
        if d and '.' in d:
            domains.append(d)

# Dedupe
seen = set()
final = []
for d in domains:
    if d not in seen:
        seen.add(d)
        final.append(d)

with open('domains.txt', 'w') as f:
    for d in final:
        f.write(d + '\n')

print(f"\nWrote {len(final)} unique domains")
for d in final[:20]:
    print(f"  {d}")
