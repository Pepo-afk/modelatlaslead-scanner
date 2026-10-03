const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
    realtime: { enabled: false }
  }
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_DOMAIN = 'hello@modelatlas.net';
const DEFAULT_FROM_NAME = 'ModelAtlas';

function getFirstName(fullName) {
  if (!fullName) return 'there';
  return fullName.trim().split(' ')[0];
}

async function getProfile(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, sender_name, ai_enabled, email, notify_signals, auto_pilot')
    .eq('id', userId)
    .single();
  return profile || {
    plan: 'free',
    sender_name: DEFAULT_FROM_NAME,
    ai_enabled: false,
    email: null,
    notify_signals: true,
    auto_pilot: false
  };
}

async function generateAIEmail(firstName, company, signalDetail, userContext, senderName, userId) {
  try {
    const response = await fetch('https://modelatlas.net/api/generate-ai-email.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SERVER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lead_first_name: firstName,
        company_name: company,
        signal_detail: signalDetail,
        user_context: userContext || '',
        sender_name: senderName,
        user_id: userId
      })
    });
    if (!response.ok) throw new Error(`AI relay failed: ${await response.text()}`);
    const data = await response.json();
    return data.email_body;
  } catch (err) {
    console.error('  AI generation error:', err.message);
    return null;
  }
}

async function sendEmailViaResend(fromAddress, to, subject, htmlBody, textBody) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: to,
      subject: subject,
      html: htmlBody,
      text: textBody,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend API error: ${response.status} ${error}`);
  }
  return response.json();
}

// ---------- USER NOTIFICATION ----------
async function sendUserNotification(userEmail, companyName, signalDescription) {
  const subject = `You have a new signal for ${companyName}`;
  const html = `<p>A new signal was detected for <strong>${companyName}</strong>:</p>
                <p><em>${signalDescription}</em></p>
                <p><a href="https://modelatlas.net">View it on ModelAtlas</a></p>`;
  const text = `You have a new signal for ${companyName}: ${signalDescription}\n\nView it here: https://modelatlas.net`;

  try {
    await sendEmailViaResend(
      `ModelAtlas <${FROM_DOMAIN}>`,
      userEmail,
      subject,
      html,
      text
    );
    console.log(`  ✅ Notification sent to ${userEmail}`);
  } catch (err) {
    console.error(`  ❌ Failed to send notification to ${userEmail}:`, err.message);
  }
}

// ---------- MAIN ----------
async function processPendingSignals() {
  console.log('Checking for pending signals...');

  const { data: signals, error } = await supabase
    .from('signals')
    .select('id, lead_id, user_id, description, signal_detail, source_url, email_subject')
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
    const profile = await getProfile(signal.user_id);
    const plan = profile.plan;
    const senderName = profile.sender_name || DEFAULT_FROM_NAME;
    const fromAddress = `${senderName} <${FROM_DOMAIN}>`;

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, email, company_name, name')
      .eq('id', signal.lead_id)
      .single();

    if (leadError || !lead || !lead.email) {
      console.log(`  Skipping signal ${signal.id}: no lead email.`);
      await supabase.from('signals').update({ email_status: 'no_email' }).eq('id', signal.id);
      continue;
    }

    // Should this signal be held for manual approval?
    const manualApproval = (plan === 'free') || (profile.auto_pilot === false);

    if (manualApproval) {
      console.log(`  Manual approval – marking signal ${signal.id} as awaiting_approval.`);
      await supabase.from('signals').update({ email_status: 'awaiting_approval' }).eq('id', signal.id);

      // Send notification to the user if we have their email and they haven't disabled notifications
      if (profile.email && profile.notify_signals !== false) {
        const signalDesc = signal.signal_detail || signal.description;
        await sendUserNotification(profile.email, lead.company_name || 'a company', signalDesc);
      } else {
        console.log('  User has no email or disabled notifications, skipping notification.');
      }
      continue;
    }

    // ---------- AUTO‑PILOT (paid users with auto_pilot on) ----------
    const firstName = getFirstName(lead.name);
    const company = lead.company_name || 'the company';
    const subject = signal.email_subject || `Quick update about ${company}`;
    const signalDetail = signal.signal_detail || signal.description;

    let htmlBody = '';
    let textBody = '';

    if (profile.ai_enabled) {
      console.log('  AI generation enabled, calling PHP relay...');
      const aiBody = await generateAIEmail(firstName, company, signalDetail, '', senderName, signal.user_id);
      if (aiBody) {
        htmlBody = `<p>${aiBody.replace(/\n/g, '<br>')}</p>`;
        textBody = aiBody;
      }
    }

    if (!htmlBody) {
      htmlBody = `
        <p>Hi ${firstName},</p>
        <p>I saw that ${company} just ${signalDetail}. That seemed like a good reason to reach out again.</p>
        <p>Are you still involved with them, or has anything changed on your end?</p>
        <p>If now is a bad time, no worries at all — just let me know.</p>
        <p>Best,<br>${senderName}</p>
      `;
      textBody = `Hi ${firstName},\n\nI saw that ${company} just ${signalDetail}. That seemed like a good reason to reach out again.\n\nAre you still involved with them, or has anything changed on your end?\n\nIf now is a bad time, no worries at all — just let me know.\n\nBest,\n${senderName}`;
    }

    // Free‑tier signature only if plan is free
    if (plan === 'free') {
      htmlBody += `<p style="color:#888; font-size:12px; margin-top:20px;">Sent with ModelAtlas – reactivate dead leads automatically.</p>`;
    }

    try {
      await sendEmailViaResend(fromAddress, lead.email, subject, htmlBody, textBody);
      console.log(`  ✅ Email sent to ${lead.email} from "${senderName}" (signal ${signal.id})`);

      await supabase.from('signals').update({
        email_status: 'sent',
        sent_at: new Date().toISOString(),
        email_body: htmlBody
      }).eq('id', signal.id);

    } catch (err) {
      console.error(`  ❌ Failed to send email for signal ${signal.id}:`, err.message);
      await supabase.from('signals').update({ email_status: 'error' }).eq('id', signal.id);
    }
  }

  console.log('Email processing complete.');
  process.exit(0);
}

processPendingSignals().catch(err => {
  console.error(err);
  process.exit(1);
});
