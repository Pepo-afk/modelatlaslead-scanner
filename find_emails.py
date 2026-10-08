import json
import subprocess
import time
import sys

with open('linkedin-profiles.json') as f:
    profiles = json.load(f)

print(f"Processing {len(profiles)} profiles")

leads = []
for p in profiles:
    name = p['name']
    domain = p['company']

    if not name or not domain:
        continue

    # Call Prospector MCP via CLI
    # Prospector exposes find_emails as an MCP tool
    cmd = [
        'npx', '-y', 'prospector-mcp',
        'find_emails',
        '--domain', domain,
        '--contact_name', name
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60
        )

        output = result.stdout.strip()
        if not output:
            print(f"  Empty output for {name}")
            continue

        # Prospector may return JSON or plain text
        try:
            data = json.loads(output)
            email = data.get('best_email') or data.get('email')
        except json.JSONDecodeError:
            # Try to extract email from plain text
            import re
            match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', output)
            email = match.group(0) if match else None

        if email:
            leads.append({
                'name': name,
                'email': email,
                'domain': domain,
                'linkedin': p['url']
            })
            print(f"  Found: {name} -> {email}")

    except subprocess.TimeoutExpired:
        print(f"  Timeout for {name}")
    except Exception as e:
        print(f"  Error for {name}: {e}")

    time.sleep(1)

with open('leads.json', 'w') as f:
    json.dump([{'email': l['email']} for l in leads], f, indent=2)

print(f"\nTotal verified emails: {len(leads)}")
for l in leads:
    print(f"  {l['name']:25s} | {l['email']:35s} | {l['domain']}")
