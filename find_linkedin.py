import json
import os
import re
import time
import urllib.request
import urllib.parse

API_KEY = os.environ['BRIGHT_DATA_API_KEY']
ZONE = os.environ['BRIGHT_DATA_ZONE']

MAX_DOMAINS = 15
MAX_SEARCHES = 60

try:
    with open('domains.txt') as f:
        domains = [line.strip() for line in f if line.strip() and '.' in line]
except FileNotFoundError:
    print("domains.txt missing.")
    exit(1)

processed = set()
try:
    with open('processed-domains.txt') as f:
        processed = set(line.strip() for line in f if line.strip())
except FileNotFoundError:
    pass

domains = [d for d in domains if d not in processed][:MAX_DOMAINS]
print(f"Processing {len(domains)} domains (cap: {MAX_DOMAINS})")

TITLES = ["SDR", "BDR", "Sales Development Representative", "Business Development Representative"]

profiles = []
seen_urls = set()
searches_done = 0
domains_completed = []

for company_domain in domains:
    if searches_done >= MAX_SEARCHES:
        break

    for title in TITLES:
        if searches_done >= MAX_SEARCHES:
            break

        query = f'site:linkedin.com/in "{title}" "@{company_domain}"'
        encoded = urllib.parse.quote(query)
        google_url = f"https://www.google.com/search?q={encoded}&brd_json=1&gl=us&hl=en"

        payload = json.dumps({"zone": ZONE, "url": google_url, "format": "raw"}).encode('utf-8')
        req = urllib.request.Request(
            "https://api.brightdata.com/request",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode('utf-8')
        except Exception as e:
            print(f"  Error {title} @ {company_domain}: {e}")
            searches_done += 1
            continue

        searches_done += 1
        print(f"  [{searches_done}/{MAX_SEARCHES}] {title} @ {company_domain}")

        try:
            data = json.loads(raw)
        except Exception:
            continue

        results = data if isinstance(data, list) else data.get('organic', [])

        for item in results:
            if not isinstance(item, dict): continue
            link = item.get('link', '') or item.get('url', '')
            item_title = item.get('title', '')

            if 'linkedin.com/in/' not in link: continue
            if link in seen_urls: continue
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

        time.sleep(1)

    domains_completed.append(company_domain)

with open('linkedin-profiles.json', 'w') as f:
    json.dump(profiles, f, indent=2)

with open('processed-domains.txt', 'a') as f:
    for d in domains_completed:
        f.write(d + '\n')

print(f"\nProfiles found: {len(profiles)}")
print(f"Domains processed: {len(domains_completed)}")
