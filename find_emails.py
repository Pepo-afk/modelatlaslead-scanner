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

def is_valid(result):
    if result.get('status') == 'VALID':
        return True
    validations = result.get('validations', {})
    if isinstance(validations, dict):
        if validations.get('mailbox_exists') is True:
            return True
    if isinstance(result.get('score'), int) and result['score'] >= 70:
        return True
    return False

# --- Load already-contacted and already-found emails to skip ---
skip_emails = set()

try:
    with open('contacted.txt') as f:
        for line in f:
            e = line.strip().lower()
            if e:
                skip_emails.add(e)
except FileNotFoundError:
    pass

try:
    with open('leads.json') as f:
        for entry in json.load(f):
            e = entry.get('email', '').lower()
            if e:
                skip_emails.add(e)
except (FileNotFoundError, json.JSONDecodeError):
    pass

print(f"Skip list size: {len(skip_emails)}")

# --- Verify verifier works ---
print("=== Verifier test ===")
try:
    test = verify_email("info@stripe.com")
    print(json.dumps(test, indent=2)[:400])
    if not is_valid(test):
        print("Verifier test failed - aborting")
        exit(1)
    print("Verifier confirmed working")
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
found_count = 0

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

        cand_lower = candidate.lower()
        if cand_lower in seen_emails:
            continue
        if cand_lower in skip_emails:
            continue
        seen_emails.add(cand_lower)
        calls += 1

        try:
            result = verify_email(candidate)
        except Exception:
            continue

        if is_valid(result):
            leads.append({
                'name': name,
                'email': candidate,
                'domain': domain,
                'linkedin': p['url'],
                'score': result.get('score', 0),
            })
            found_count += 1
            print(f"  OK: {name} -> {candidate} (score {result.get('score', '?')})")
            found = True

        time.sleep(0.3)

with open('leads.json', 'w') as f:
    json.dump([{'email': l['email']} for l in leads], f, indent=2)

with open('leads-full.json', 'w') as f:
    json.dump(leads, f, indent=2)

print(f"\nEmails found: {found_count} / calls used: {calls}")
