import json
import time
import urllib.request
import urllib.parse

VERIFY_URL = "https://rapid-email-verifier.fly.dev/api/validate"

def verify_email(email):
    url = f"{VERIFY_URL}?email={urllib.parse.quote(email)}"
    req = urllib.request.Request(url, headers={'User-Agent': 'ModelAtlas/1.0'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))

print("=== Verifier test ===")
try:
    test = verify_email("info@stripe.com")
    print(json.dumps(test, indent=2)[:400])
except Exception as e:
    print(f"Verifier error: {e}")
    exit(1)

def generate_permutations(first, last, domain):
    f, l = first.lower(), last.lower()
    return [
        f"{f}.{l}@{domain}",
        f"{f}@{domain}",
        f"{f}{l}@{domain}",
        f"{f[0]}.{l}@{domain}",
        f"{f}.{l[0]}@{domain}",
        f"{f}_{l}@{domain}",
        f"{f[0]}{l}@{domain}",
    ]

try:
    with open('linkedin-profiles.json') as f:
        profiles = json.load(f)
except FileNotFoundError:
    print("No linkedin-profiles.json found.")
    exit(1)

print(f"\nProfiles: {len(profiles)}")

leads = []
seen_emails = set()
calls = 0
MAX_CALLS = 500

for p in profiles:
    if calls >= MAX_CALLS:
        break

    name = p.get('name', '').strip()
    domain = p.get('company_domain', '').strip()

    if not name or not domain:
        continue

    parts = name.split()
    if len(parts) < 2:
        continue
    first, last = parts[0], parts[-1]

    if len(first) < 2 or len(last) < 2:
        continue

    found = False
    for candidate in generate_permutations(first, last, domain):
        if calls >= MAX_CALLS or found:
            break
        if candidate in seen_emails:
            continue
        seen_emails.add(candidate)
        calls += 1

        try:
            result = verify_email(candidate)
        except Exception as e:
            continue

        is_valid = (
            result.get('valid') is True or
            result.get('is_valid') is True or
            (isinstance(result.get('smtp'), dict) and result['smtp'].get('valid') is True)
        )

        if is_valid:
            leads.append({
                'name': name,
                'email': candidate,
                'domain': domain,
                'linkedin': p['url'],
            })
            print(f"  OK: {name} -> {candidate}")
            found = True

        time.sleep(0.3)

with open('leads.json', 'w') as f:
    json.dump([{'email': l['email']} for l in leads], f, indent=2)

print(f"\nEmails found: {len(leads)} / calls used: {calls}")
