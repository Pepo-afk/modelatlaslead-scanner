import json
import os
import re
import time
import urllib.request
import urllib.parse

API_KEY = os.environ['BRIGHT_DATA_API_KEY']
ZONE = os.environ['BRIGHT_DATA_ZONE']

COMPANIES = [
    "belkins.io",
    "builtforb2b.com",
    "punchb2b.com",
    "qualitycontactsolutions.com",
    "memoryblue.com",
    "marketjoy.com",
    "saleshive.com",
    "konsyg.com",
]

TITLES = [
    "SDR",
    "BDR",
    "Sales Development Representative",
    "Business Development Representative",
]

profiles = []
seen_urls = set()

for company in COMPANIES:
    for title in TITLES:
        query = f'site:linkedin.com/in "{title}" "{company}"'
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
            print(f"  HTTP error for {title} at {company}: {e}")
            continue

        # Bright Data may return JSON directly or wrapped
        try:
            data = json.loads(raw)
        except Exception:
            print(f"  Non-JSON response for {title} at {company}: {raw[:200]}")
            continue

        # Handle both possible shapes
        if isinstance(data, list):
            results = data
        else:
            results = data.get('organic', [])

        print(f"  {title} at {company}: {len(results)} results")

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

            name_match = re.match(r'^([^-|]+)', item_title)
            name = name_match.group(1).strip() if name_match else ''

            if name:
                profiles.append({
                    'name': name,
                    'url': link,
                    'snippet': snippet,
                    'company': company
                })

        time.sleep(2)

with open('linkedin-profiles.json', 'w') as f:
    json.dump(profiles, f, indent=2)

print(f"\nTotal profiles found: {len(profiles)}")
for p in profiles[:30]:
    print(f"  {p['name']:30s} | {p['company']:30s} | {p['url']}") 
