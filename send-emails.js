const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ============================================================
// YOUR VERIFIED SENDING ADDRESS
// ============================================================
const FROM_ADDRESS = 'ModelAtlas <hello@modelatlas.net>';

// Helper to safely get the first name from a full name string
function getFirstName(fullName) {
  if (!fullName) return null;
  return fullName.trim().split(' ')[0];
}

async function sendEmailViaResend(to, subject, htmlBody, textBody) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: to,
      subject: subject,
      html: htmlBody,
      text: textBody,   // plain text fallback, prevents spam labelling
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend API error: ${response.status} ${error}`);
  }

  return response.json();
}

async function processPendingSignals() {
  console.log('Checking for pending signals...');

  const { data: signals, error } = await supabase
    .from('signals')
    .select('id, lead_id, user_id, description, source_url, email_subject')
    .eq('email_status', 'pending');

  if (error) {
    console.error('Error fetching signals:', error.message);
    return;
  }

  if (!signals || signals.length === 0) {
    console.log('No pending signals.');
    return;
  }

  console.log(`Found ${signals.length} pending signal(s).`);

  for (const signal of signals) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', signal.user_id)
      .single();

    if (profileError || !profile) {
      console.log(`  Skipping signal ${signal.id}: no profile.`);
      continue;
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, email, company_name, name')   // also fetch lead's name if available
      .eq('id', signal.lead_id)
      .single();

    if (leadError || !lead || !lead.email) {
      console.log(`  Skipping signal ${signal.id}: no lead email.`);
      await supabase.from('signals').update({ email_status: 'no_email' }).eq('id', signal.id);
      continue;
    }

    // Free users – awaiting manual approval
    if (profile.plan === 'free') {
      console.log(`  Free plan – marking signal ${signal.id} as awaiting_approval.`);
      await supabase.from('signals').update({ email_status: 'awaiting_approval' }).eq('id', signal.id);
      continue;
    }

    // Prepare the email content
    const firstName = getFirstName(lead.name) || 'there';
    const company = lead.company_name || 'the company';
    const signalDescription = signal.description.toLowerCase().replace('signals detected: ', '');
    const sourceUrl = signal.source_url.startsWith('http') 
      ? signal.source_url 
      : 'https://' + signal.source_url;   // ensure full URL

    const subject = `Quick update about ${company}`;

    // HTML version – natural language, no obvious templating
    const htmlBody = `
      <p>Hi ${firstName},</p>
      <p>I was just checking on <strong>${company}</strong> and noticed something interesting:</p>
      <p><em>${signalDescription}</em></p>
      <p>You can see it here: <a href="${sourceUrl}">${sourceUrl}</a></p>
      <p>Might be worth a quick follow‑up. Let me know if you'd like me to dig deeper.</p>
      <p>Cheers,<br>ModelAtlas</p>
    `;

    // Plain text fallback (important for deliverability)
    const textBody = `Hi ${firstName},\n\nI was just checking on ${company} and noticed something interesting:\n\n${signalDescription}\n\nSee it here: ${sourceUrl}\n\nMight be worth a quick follow‑up. Let me know if you'd like me to dig deeper.\n\nCheers,\nModelAtlas`;

    try {
      await sendEmailViaResend(lead.email, subject, htmlBody, textBody);
      console.log(`  ✅ Email sent to ${lead.email} (signal ${signal.id})`);

      await supabase.from('signals').update({
        email_status: 'sent',
        sent_at: new Date().toISOString(),
        email_body: htmlBody   // store the HTML version for the history
      }).eq('id', signal.id);

    } catch (err) {
      console.error(`  ❌ Failed to send email for signal ${signal.id}:`, err.message);
      await supabase.from('signals').update({ email_status: 'error' }).eq('id', signal.id);
    }
  }

  console.log('Email processing complete.');
}

processPendingSignals().catch(console.error); 
