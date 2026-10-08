import json
import os
import re
import time
import urllib.request
import urllib.parse

API_KEY = os.environ['BRIGHT_DATA_API_KEY']
ZONE = os.environ['BRIGHT_DATA_ZONE']

try:
    with open('domains.txt') as f:
        domains = [line.strip() for line in f if line.strip() and '.' in line]
except FileNotFoundError:
    print("domains.txt missing. Run fetch_companies.py first.")
    exit(1)

print(f"Loaded {len(domains)} domains")

TITLES = ["SDR", "BDR", "Sales Development Representative", "Business Development Representative"]

profiles = []
seen_urls = set()

for company_domain in domains[:25]:
    for title in TITLES:
        query = f'site:linkedin.com/in "{title}" "@{company_domain}"'
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
            print(f"  Error {title} @ {company_domain}: {e}")
            continue

        try:
            data = json.loads(raw)
        except Exception:
            continue

        results = data if isinstance(data, list) else data.get('organic', [])

        for item in results:
            if not isinstance(item, dict):
                continue
            link = item.get('link', '') or item.get('url', '')
            item_title = item.get('title', '')

            if 'linkedin.com/in/' not in link:
                continue
            if link in seen_urls:
                continue
            seen_urls.add(link)

            name_part = item_title
            for sep in [' – ', ' - ', ' | ', ' at ', ' @ ', ' — ']:
                if sep in name_part:
                    name_part = name_part.split(sep)[0]
            name_part = re.sub(r'[^\w\s\'.\-]', '', name_part).strip()
            name_part = re.sub(r',\s*[A-Z]{2,}$', '', name_part).strip()

            if name_part and len(name_part.split()) >= 2:
                profiles.append({
                    'name': name_part,
                    'url': link,
                    'company_domain': company_domain,
                })

        time.sleep(1.5)

with open('linkedin-profiles.json', 'w') as f:
    json.dump(profiles, f, indent=2)

print(f"\nTotal profiles: {len(profiles)}")
for p in profiles[:20]:
    print(f"  {p['name']:35s} | {p['company_domain']}")
