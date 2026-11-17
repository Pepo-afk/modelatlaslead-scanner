const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// Get mailbox and decrypt its password from Vault
async function getMailboxWithPassword(userId) {
  // 1. Get the active mailbox for this user
  const { data: mailbox, error } = await supabase
    .from('user_mailboxes')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error || !mailbox) return null;

  // 2. Get password from Vault using the RPC we created
  const { data: secret, error: secretError } = await supabase
    .rpc('get_decrypted_secret', { secret_name: 'mailbox_' + mailbox.id });

  if (secretError || !secret) {
    console.error(`Failed to retrieve vault password for mailbox ${mailbox.id}`);
    return null;
  }

  return { ...mailbox, password: secret };
}

// Send via Nodemailer (SMTP)
async function sendEmailViaSMTP(mailbox, to, subject, htmlBody) {
  const transporter = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465, // true for 465, false for 587
    auth: {
      user: mailbox.email_address,
      pass: mailbox.password,
    },
  });

  return await transporter.sendMail({
    from: `"${mailbox.email_address}" <${mailbox.email_address}>`,
    to,
    subject,
    html: htmlBody,
  });
}

async function processPendingSignals() {
  console.log('Checking for pending signals...');

  const { data: signals, error } = await supabase
    .from('signals')
    .select('id, lead_id, user_id, description, signal_detail, suggested_opener, email_subject')
    .eq('email_status', 'pending');

  if (error || !signals || signals.length === 0) {
    console.log('No pending signals.');
    return;
  }

  console.log(`Found ${signals.length} pending signal(s).`);

  // Group signals by user
  const signalsByUser = {};
  for (const signal of signals) {
    if (!signalsByUser[signal.user_id]) signalsByUser[signal.user_id] = [];
    signalsByUser[signal.user_id].push(signal);
  }

  for (const [userId, userSignals] of Object.entries(signalsByUser)) {
    const mailbox = await getMailboxWithPassword(userId);
    
    if (!mailbox) {
      console.log(`Skipping user ${userId}: No active mailbox or Vault access failed.`);
      // Mark as error so they don't pile up
      await supabase.from('signals').update({ email_status: 'error' }).in('id', userSignals.map(s => s.id));
      continue;
    }

    for (const signal of userSignals) {
      // Fetch lead details
      const { data: lead } = await supabase
        .from('leads')
        .select('id, email, company_name, name')
        .eq('id', signal.lead_id)
        .single();

      if (!lead || !lead.email) {
        await supabase.from('signals').update({ email_status: 'no_email' }).eq('id', signal.id);
        continue;
      }

      const firstName = lead.name ? lead.name.split(' ')[0] : 'there';
      const company = lead.company_name || 'the company';
      const subject = signal.email_subject || `Quick update about ${company}`;
      const detail = signal.signal_detail || signal.description;
      const opener = signal.suggested_opener ? `"${signal.suggested_opener}"` : `I saw that ${company} just ${detail}. That seemed like a good reason to reach out again.`;

      const htmlBody = `
        <p>Hi ${firstName},</p>
        <p>${opener}</p>
        <p>Are you still involved with them, or has anything changed on your end?</p>
        <p>If now is a bad time, no worries at all — just let me know.</p>
        <p>Best,<br>${mailbox.email_address.split('@')[0]}</p>
      `;

      try {
        await sendEmailViaSMTP(mailbox, lead.email, subject, htmlBody);
        await supabase.from('signals').update({ 
          email_status: 'sent', 
          sent_at: new Date().toISOString(),
          email_body: htmlBody
        }).eq('id', signal.id);
        
        console.log(`  ✅ Email sent to ${lead.email} from ${mailbox.email_address}`);
        
        // Very important: Delay between emails to protect the user's SMTP reputation
        await new Promise(resolve => setTimeout(resolve, 3000));
        
      } catch (err) {
        console.error(`  ❌ SMTP Failed for ${lead.email}:`, err.message);
        await supabase.from('signals').update({ email_status: 'error' }).eq('id', signal.id);
      }
    }
  }

  console.log('Email processing complete.');
  process.exit(0);
}

processPendingSignals().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
