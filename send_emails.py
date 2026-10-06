import os
import json
import smtplib
import sys
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

SMTP_SERVER = 'live.smtp.mailtrap.io'
SMTP_PORT = 587
SMTP_LOGIN = os.environ['MAILTRAP_SMTP_USER']
SMTP_PASSWORD = os.environ['MAILTRAP_SMTP_PASSWORD']

SENDER_EMAIL = 'hello@try.modelatlas.net'
SENDER_NAME = 'Pietro from ModelAtlas'
REPLY_TO = 'modelatlas7@gmail.com'

MAX_PER_RUN = 5

SUBJECT = 'your old leads'

BODY_TEMPLATE = """Every SDR has the same problem. Thousands of cold leads. No way to know which are ready to buy.

ModelAtlas watches companies for signals. Funding, hiring, launches. When one fires at a company you already have as a lead, you get an alert. That's the whole product.

Free for your first 10 companies. Reply and I'll set it up."""

leads_file = sys.argv[1] if len(sys.argv) > 1 else 'leads.json'
with open(leads_file, 'r') as f:
    leads = json.load(f)

contacted = set()
try:
    with open('contacted.txt', 'r') as f:
        for line in f:
            contacted.add(line.strip())
except FileNotFoundError:
    pass

sent = 0
for lead in leads:
    if sent >= MAX_PER_RUN:
        break
    email = lead.get('email')
    if not email or email in contacted:
        continue

    msg = MIMEMultipart('alternative')
    msg['Subject'] = SUBJECT
    msg['From'] = f'{SENDER_NAME} <{SENDER_EMAIL}>'
    msg['To'] = email
    msg['Reply-To'] = REPLY_TO
    msg.attach(MIMEText(BODY_TEMPLATE, 'plain'))

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_LOGIN, SMTP_PASSWORD)
            server.sendmail(SENDER_EMAIL, email, msg.as_string())
        print(f'Sent: {email}')
        contacted.add(email)
        sent += 1
    except Exception as e:
        print(f'Failed: {email} - {e}')

with open('contacted.txt', 'w') as f:
    for email in sorted(contacted):
        f.write(email + '\n')

print(f'Total sent: {sent}') 
