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

async function getProfile(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, sender_name, ai_enabled')
    .eq('id', userId)
    .single();
  return profile || { plan: 'free', sender_name: DEFAULT_FROM_NAME, ai_enabled: false };
}

// ---------- AI GENERATION (via PHP relay) ----------
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
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI relay failed: ${err}`);
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
    // 1. Get user profile
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

    // 3. Free users – only send if manually approved (status was set to pending by frontend)
    if (plan === 'free') {
      console.log(`  Free plan – marking signal ${signal.id} as awaiting_approval.`);
      await supabase.from('signals').update({ email_status: 'awaiting_approval' }).eq('id', signal.id);
      continue;
    }

    // 4. Prepare email content
    const firstName = getFirstName(lead.name);
    const company = lead.company_name || 'the company';
    const subject = signal.email_subject || `Quick update about ${company}`;
    const signalDetail = signal.signal_detail || signal.description;

    let htmlBody = '';
    let textBody = '';

    // AI generation for Pro users with ai_enabled
    if (profile.ai_enabled) {
      console.log('  AI generation enabled, calling PHP relay...');
      const aiBody = await generateAIEmail(firstName, company, signalDetail, '', senderName, signal.user_id);
      if (aiBody) {
        htmlBody = `<p>${aiBody.replace(/\n/g, '<br>')}</p>`;
        textBody = aiBody;
      }
    }

    // Fallback to default template
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

    // Free-tier signature
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
