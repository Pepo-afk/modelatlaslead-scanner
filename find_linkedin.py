import json
import os
import re
import time
import urllib.request
import urllib.parse

API_KEY = os.environ['BRIGHT_DATA_API_KEY']
ZONE = os.environ['BRIGHT_DATA_ZONE']

# No fixed company list. Broad ICP-targeted queries.
QUERIES = [
    'site:linkedin.com/in "SDR" "B2B" "outbound" -recruiter -"looking for"',
    'site:linkedin.com/in "Sales Development Representative" "agency" -recruiter',
    'site:linkedin.com/in "BDR" "B2B" "cold email" -recruiter',
    'site:linkedin.com/in "Business Development Representative" "outbound agency"',
    'site:linkedin.com/in "SDR" "cold email" "appointment setting"',
    'site:linkedin.com/in "Sales Development Representative" "10-50 employees"',
    'site:linkedin.com/in "SDR" "lead generation" "remote"',
    'site:linkedin.com/in "BDR" "outbound" "SaaS" -recruiter',
]

profiles = []
seen_urls = set()

for query in QUERIES:
    encoded = urllib.parse.quote(query)
    google_url = f"https://www.google.com/search?q={encoded}&brd_json=1&gl=us&hl=en"

    payload = json.dumps({
        "zone": ZONE,
        "url": google_url,
        "format": "raw"
    }).encode('utf-8')

    req = urllib.request.Request(
        "https://api.brightdata.com/request",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode('utf-8')
    except Exception as e:
        print(f"  HTTP error: {e}")
        continue

    try:
        data = json.loads(raw)
    except Exception:
        print(f"  Non-JSON response")
        continue

    results = data if isinstance(data, list) else data.get('organic', [])
    print(f"  Query returned {len(results)} results")

    for item in results:
        if not isinstance(item, dict):
            continue
        link = item.get('link', '') or item.get('url', '')
        item_title = item.get('title', '')
        snippet = item.get('snippet', '') or item.get('description', '')

        if 'linkedin.com/in/' not in link:
            continue
        if link in seen_urls:
            continue
        seen_urls.add(link)

        # Clean name extraction (no titles, no emojis)
        name_part = item_title
        for sep in [' – ', ' - ', ' | ', ' at ', ' @ ', ' — ']:
            if sep in name_part:
                name_part = name_part.split(sep)[0]
        name_part = re.sub(r'[^\w\s\'.\-]', '', name_part).strip()
        name_part = re.sub(r',\s*[A-Z]{2,}$', '', name_part).strip()
        name = name_part

        # Extract company domain from snippet
        company_domain = None
        domain_match = re.search(r'at\s+([A-Z][\w&]+(?:\s+[A-Z][\w&]+)*)', snippet)
        company_name = domain_match.group(1).strip() if domain_match else None

        # Also try to find explicit domains
        domain_match2 = re.search(r'\b([\w-]+\.(?:com|io|ai|co|net))\b', snippet)
        if domain_match2 and 'linkedin' not in domain_match2.group(1):
            company_domain = domain_match2.group(1)

        if name and len(name.split()) >= 2:
            profiles.append({
                'name': name,
                'url': link,
                'snippet': snippet,
                'company_name': company_name,
                'company_domain': company_domain,
            })

    time.sleep(2)

with open('linkedin-profiles.json', 'w') as f:
    json.dump(profiles, f, indent=2)

print(f"\nTotal profiles: {len(profiles)}")
for p in profiles[:20]:
    print(f"  {p['name']:35s} | {p.get('company_domain') or p.get('company_name') or 'unknown'}")
