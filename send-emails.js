const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DEFAULT_FROM_DOMAIN = 'hello@try.modelatlas.net'; // Used for app notifications

function getFirstName(fullName) {
  if (!fullName) return 'there';
  return fullName.trim().split(' ')[0];
}

async function getProfile(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, sender_name, ai_enabled, email, notify_signals, auto_pilot, digest_frequency')
    .eq('id', userId)
    .single();
    
  return profile || { 
    plan: 'free', sender_name: 'ModelAtlas', ai_enabled: false, 
    email: null, notify_signals: true, auto_pilot: false, digest_frequency: 'weekly'
  };
}

// --- RESEND: For App Notifications (Summaries) ---
async function sendEmailViaResend(fromAddress, to, subject, htmlBody, textBody) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress, to, subject, html: htmlBody, text: textBody }),
  });
  if (!response.ok) throw new Error(`Resend API error: ${response.status} ${await response.text()}`);
  return response.json();
}

async function sendSummaryNotification(userEmail, signals) {
  const count = signals.length;
  const topSignal = signals[0];
  const company = topSignal.company_name || 'a company';
  const detail = topSignal.signal_detail || topSignal.description;
  const opener = topSignal.suggested_opener || '';

  const subject = `You have ${count} new signals today`;
  const html = `
    <h2>You have ${count} new signals today</h2>
    <p>Here is your top signal:</p>
    <div style="background: #f9fafb; padding: 15px; border-left: 4px solid #4F46E5; margin-bottom: 20px;">
      <h3 style="margin-top: 0;">${company}</h3>
      <p>${detail}</p>
      ${opener ? `<p><em>"${opener}"</em></p>` : ''}
    </div>
    <p><a href="https://modelatlas.net">Log in to ModelAtlas to see the rest</a></p>
  `;
  const text = `You have ${count} new signals today.\n\nTop signal at ${company}: ${detail}\n\nLog in to see the rest: https://modelatlas.net`;

  try {
    await sendEmailViaResend(`ModelAtlas <${DEFAULT_FROM_DOMAIN}>`, userEmail, subject, html, text);
    console.log(`  ✅ Summary sent to ${userEmail} (${count} signals)`);
  } catch (err) {
    console.error(`  ❌ Failed to send summary to ${userEmail}:`, err.message);
  }
}

// --- NODEMAILER: For User Outreach (BYOM) ---
async function getMailboxWithPassword(userId) {
  const { data: mailbox } = await supabase
    .from('user_mailboxes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (!mailbox) return null;

  const { data: secret } = await supabase.rpc('get_decrypted_secret', { secret_name: 'mailbox_' + mailbox.id });
  if (!secret) return null;

  return { ...mailbox, password: secret };
}

async function sendOutreachViaSMTP(mailbox, to, subject, htmlBody) {
  const transporter = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465,
    auth: { user: mailbox.email_address, pass: mailbox.password },
  });

  return await transporter.sendMail({
    from: `"${mailbox.email_address.split('@')[0]}" <${mailbox.email_address}>`,
    to,
    subject,
    html: htmlBody,
  });
}

async function generateAIEmail(firstName, company, signalDetail, userContext, senderName, userId) {
  try {
    const response = await fetch('https://modelatlas.net/api/generate-ai-email.php', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.SERVER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_first_name: firstName, company_name: company, signal_detail: signalDetail, user_context: userContext || '', sender_name: senderName, user_id: userId })
    });
    if (!response.ok) throw new Error(`AI relay failed: ${await response.text()}`);
    const data = await response.json();
    return data.email_body;
  } catch (err) {
    console.error('  AI generation error:', err.message);
    return null;
  }
}

// ---------- MAIN ----------
async function processPendingSignals() {
  console.log('Checking for pending signals...');

  const { data: signals, error } = await supabase
    .from('signals')
    .select('id, lead_id, user_id, description, signal_detail, suggested_opener, source_url, email_subject')
    .eq('email_status', 'pending');

  if (error || !signals || signals.length === 0) {
    console.log('No pending signals.');
    return;
  }

  console.log(`Found ${signals.length} pending signal(s).`);

  const signalsByUser = {};
  for (const signal of signals) {
    if (!signalsByUser[signal.user_id]) signalsByUser[signal.user_id] = [];
    signalsByUser[signal.user_id].push(signal);
  }

  const isMonday = new Date().getDay() === 1;

  for (const [userId, userSignals] of Object.entries(signalsByUser)) {
    const profile = await getProfile(userId);
    
    // 1. Digest Frequency Check
    if (profile.digest_frequency === 'off') continue;
    if (profile.digest_frequency === 'weekly' && !isMonday) continue;

    const senderName = profile.sender_name || 'ModelAtlas';

    // 2. Send Summary Notification (via Resend)
    if (profile.email && profile.notify_signals !== false) {
      await sendSummaryNotification(profile.email, userSignals);
    }

    // 3. Process Outreach (via SMTP)
    const manualApproval = (profile.plan === 'free') || (profile.auto_pilot === false);
    
    for (const signal of userSignals) {
      const { data: lead } = await supabase.from('leads').select('id, email, company_name, name').eq('id', signal.lead_id).single();

      if (!lead || !lead.email) {
        await supabase.from('signals').update({ email_status: 'no_email' }).eq('id', signal.id);
        continue;
      }

      if (manualApproval) {
        await supabase.from('signals').update({ email_status: 'awaiting_approval' }).eq('id', signal.id);
        continue;
      }

      // Auto-pilot path
      const mailbox = await getMailboxWithPassword(userId);
      if (!mailbox) {
        console.log(`  Skipping outreach for user ${userId}: No active mailbox connected.`);
        await supabase.from('signals').update({ email_status: 'error_no_mailbox' }).eq('id', signal.id);
        continue;
      }

      const firstName = getFirstName(lead.name);
      const company = lead.company_name || 'the company';
      const subject = signal.email_subject || `Quick update about ${company}`;
      const signalDetail = signal.signal_detail || signal.description;
      
      let htmlBody = '';
      if (profile.ai_enabled) {
        const aiBody = await generateAIEmail(firstName, company, signalDetail, '', senderName, signal.user_id);
        if (aiBody) htmlBody = `<p>${aiBody.replace(/\n/g, '<br>')}</p>`;
      }

      if (!htmlBody) {
        const openerText = signal.suggested_opener ? `"${signal.suggested_opener}"` : `I saw that ${company} just ${signalDetail}. That seemed like a good reason to reach out again.`;
        htmlBody = `
          <p>Hi ${firstName},</p>
          <p>${openerText}</p>
          <p>Are you still involved with them, or has anything changed on your end?</p>
          <p>If now is a bad time, no worries at all — just let me know.</p>
          <p>Best,<br>${senderName}</p>
        `;
      }

      try {
        await sendOutreachViaSMTP(mailbox, lead.email, subject, htmlBody);
        await supabase.from('signals').update({ email_status: 'sent', sent_at: new Date().toISOString(), email_body: htmlBody }).eq('id', signal.id);
        console.log(`  ✅ Outreach sent to ${lead.email} from ${mailbox.email_address}`);
        
        // Delay to protect SMTP reputation
        await new Promise(r => setTimeout(r, 3000));
      } catch (err) {
        console.error(`  ❌ SMTP Failed to ${lead.email}:`, err.message);
        await supabase.from('signals').update({ email_status: 'error' }).eq('id', signal.id);
      }
    }
  }

  console.log('Email processing complete.');
  process.exit(0);
}

processPendingSignals().catch(err => {
  console.error(err);
  process.exit(1);
});
