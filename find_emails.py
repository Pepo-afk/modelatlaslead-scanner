import json
import re
import time
import urllib.request
import urllib.parse

VERIFY_URL = "https://rapid-email-verifier.fly.dev/api/validate"

# Common patterns. Keep it small to save verification budget.
def generate_permutations(first, last, domain):
    f = first.lower()
    l = last.lower()
    return [
        f"{f}.{l}@{domain}",
        f"{f}@{domain}",
        f"{f}{l}@{domain}",
        f"{f[0]}.{l}@{domain}",
        f"{f}.{l[0]}@{domain}",
        f"{f}_{l}@{domain}",
    ]

def verify_email(email):
    try:
        url = f"{VERIFY_URL}?email={urllib.parse.quote(email)}"
        req = urllib.request.Request(url, headers={'User-Agent': 'ModelAtlas/1.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data
    except Exception as e:
        return {'error': str(e)}

with open('linkedin-profiles.json') as f:
    profiles = json.load(f)

print(f"Processing {len(profiles)} profiles")

leads = []
seen_emails = set()
verified_count = 0
MAX_VERIFICATIONS = 900  # Stay under free tier

for p in profiles:
    if verified_count >= MAX_VERIFICATIONS:
        print(f"  Reached verification limit")
        break

    name = p.get('name', '').strip()
    domain = p.get('company_domain')

    if not name or not domain:
        continue

    parts = name.split()
    if len(parts) < 2:
        continue
    first = parts[0]
    last = parts[-1]

    # Skip obviously wrong names
    if len(first) < 2 or len(last) < 2:
        continue
    if any(c.isdigit() for c in first + last):
        continue

    found = False
    for candidate in generate_permutations(first, last, domain):
        if verified_count >= MAX_VERIFICATIONS:
            break
        if found:
            break
        if candidate in seen_emails:
            continue
        seen_emails.add(candidate)
        verified_count += 1

        result = verify_email(candidate)
        is_valid = result.get('valid') or result.get('is_valid') or result.get('smtp', {}).get('valid')

        if is_valid:
            leads.append({
                'name': name,
                'email': candidate,
                'domain': domain,
                'linkedin': p['url'],
            })
            print(f"  ✓ {name} -> {candidate}")
            found = True
            break

        time.sleep(0.2)

with open('leads.json', 'w') as f:
    json.dump([{'email': l['email']} for l in leads], f, indent=2)

print(f"\nTotal verified emails: {len(leads)}")
print(f"Total verification calls used: {verified_count}")
for l in leads:
    print(f"  {l['name']:30s} | {l['email']}")
