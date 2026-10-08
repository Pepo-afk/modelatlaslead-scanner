import json
import os
import re
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
        url = f"https://www.google.com/search?q={encoded}"

        payload = json.dumps({
            "zone": ZONE,
            "url": url,
            "format": "json",
            "data_format": "json"
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
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            print(f"  Failed for {title} at {company}: {e}")
            continue

        results = data.get('organic', [])
        print(f"  {title} at {company}: {len(results)} results")

        for item in results:
            link = item.get('link', '')
            item_title = item.get('title', '')
            snippet = item.get('snippet', '')

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

with open('linkedin-profiles.json', 'w') as f:
    json.dump(profiles, f, indent=2)

print(f"\nTotal profiles found: {len(profiles)}")
for p in profiles[:20]:
    print(f"  {p['name']:30s} | {p['company']}")
