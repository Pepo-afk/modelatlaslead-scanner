const { createClient } = require('@supabase/supabase-js');

// Realtime disabled to prevent process hanging
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

// ---------- HELPERS ----------
function getFirstName(fullName) {
  if (!fullName) return 'there';
  return fullName.trim().split(' ')[0];
}

function formatSignalDetail(description) {
  let detail = description.replace(/signals detected:\s*/i, '').trim();
  const map = {
    funding: 'raised new funding',
    launch: 'launched a new product or feature',
    hiring: 'started hiring aggressively',
    expansion: 'expanded to a new location or market',
    partnership: 'announced a new partnership',
    rebranding: 'rebranded or refreshed their look',
    leadership: 'made a leadership change',
    multi: 'had some notable updates',
  };
  if (map[detail]) return map[detail];
  if (detail.includes(',')) return 'had some notable updates';
  return detail;
}

async function getProfile(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, sender_name, ai_enabled')
    .eq('id', userId)
    .single();
  return profile || { plan: 'free', sender_name: DEFAULT_FROM_NAME, ai_enabled: false };
}

// ---------- AI GENERATION ----------
async function generateAIEmail(firstName, company, signalDetail, userContext, senderName) {
  try {
    const response = await fetch(
      'https://<YOUR_SUPABASE_PROJECT_REF>.functions.supabase.co/generate-ai-email',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          lead_first_name: firstName,
          company_name: company,
          signal_detail: signalDetail,
          user_context: userContext || '',
          sender_name: senderName
        })
      }
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI function failed: ${err}`);
    }
    const data = await response.json();
    return data.email_body;
  } catch (err) {
    console.error('  AI generation error:', err.message);
    return null;
  }
}

// ---------- EMAIL SENDING ----------
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

// ---------- MAIN ----------
async function processPendingSignals() {
  console.log('Checking for pending signals...');

  // Fetch all pending signals, now including signal_detail
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
    // 1. Get user profile (plan, sender name, AI flag)
    const profile = await getProfile(signal.user_id);
    const plan = profile.plan;
    const senderName = profile.sender_name || DEFAULT_FROM_NAME;
    const fromAddress = `${senderName} <${FROM_DOMAIN}>`;

    // 2. Get lead info
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

    // 3. Free users – only send if approved (status was manually set to pending)
    // For auto-pilot (paid), we proceed directly.
    if (plan === 'free') {
      console.log(`  Free plan – marking signal ${signal.id} as awaiting_approval.`);
      await supabase.from('signals').update({ email_status: 'awaiting_approval' }).eq('id', signal.id);
      continue;
    }

    // 4. Prepare email content
    const firstName = getFirstName(lead.name);
    const company = lead.company_name || 'the company';
    const subject = signal.email_subject || `Quick update about ${company}`;

    // Use the rich signal detail if available; otherwise fall back to the generic description
    const signalDetail = signal.signal_detail || formatSignalDetail(signal.description);

    let htmlBody = '';
    let textBody = '';

    // AI generation for Pro users who have ai_enabled
    if (profile.ai_enabled) {
      console.log('  AI generation enabled, calling generate-ai-email...');
      const aiBody = await generateAIEmail(firstName, company, signalDetail, '', senderName);
      if (aiBody) {
        // Wrap the plain text AI email in simple HTML
        htmlBody = `<p>${aiBody.replace(/\n/g, '<br>')}</p>`;
        textBody = aiBody;
      }
    }

    // Fallback to the default human template if AI not enabled or failed
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

    // Free-tier signature (even if AI generated, we still append the modelatlas signature for free plans)
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
