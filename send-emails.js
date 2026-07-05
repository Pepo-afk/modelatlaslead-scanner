const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ============================================================
// CONFIGURE YOUR SENDING ADDRESS HERE
// ============================================================
const FROM_ADDRESS = 'ModelAtlas <hello@modelatlas.net>';   // ← change this to your own verified domain

async function sendEmailViaResend(to, subject, body) {
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
      html: body,
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
    // 1. Get user's profile (plan)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', signal.user_id)
      .single();

    if (profileError || !profile) {
      console.log(`  Skipping signal ${signal.id}: no profile.`);
      continue;
    }

    // 2. Get the lead's email
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('email, company_name')
      .eq('id', signal.lead_id)
      .single();

    if (leadError || !lead || !lead.email) {
      console.log(`  Skipping signal ${signal.id}: no lead email.`);
      await supabase.from('signals').update({ email_status: 'no_email' }).eq('id', signal.id);
      continue;
    }

    // 3. Free users – just mark as awaiting approval (they'll approve manually in the app)
    if (profile.plan === 'free') {
      console.log(`  Free plan – marking signal ${signal.id} as awaiting_approval.`);
      await supabase.from('signals').update({ email_status: 'awaiting_approval' }).eq('id', signal.id);
      continue;
    }

    // 4. Paid users – send the email now
    const subject = signal.email_subject || `Update about ${lead.company_name}`;
    const body = `
      <p>Hi,</p>
      <p>I noticed some recent activity at <strong>${lead.company_name}</strong>:</p>
      <p><em>${signal.description}</em></p>
      <p>Source: <a href="${signal.source_url}">${signal.source_url}</a></p>
      <p>Thought you might find this interesting.</p>
      <p>– ModelAtlas</p>
    `;

    try {
      await sendEmailViaResend(lead.email, subject, body);
      console.log(`  ✅ Email sent to ${lead.email} (signal ${signal.id})`);

      await supabase.from('signals').update({
        email_status: 'sent',
        sent_at: new Date().toISOString(),
        email_body: body
      }).eq('id', signal.id);

    } catch (err) {
      console.error(`  ❌ Failed to send email for signal ${signal.id}:`, err.message);
      await supabase.from('signals').update({ email_status: 'error' }).eq('id', signal.id);
    }
  }

  console.log('Email processing complete.');
}

processPendingSignals().catch(console.error);
