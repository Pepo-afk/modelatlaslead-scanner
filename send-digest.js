const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sendDigests() {
  console.log('Starting weekly digest...');
  
  // Get all users who have preferences set
  const { data: profiles } = await supabase.from('profiles').select('id, email, signal_preferences').not('signal_preferences', 'is', null);
  
  if (!profiles) return;

  for (const profile of profiles) {
    // Get top 3 signals matching their preferences from the last 7 days
    let query = supabase
      .from('signals')
      .select('company_name, signal_detail, suggested_opener')
      .gte('detected_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('confidence', { ascending: false })
      .limit(3);

    if (profile.signal_preferences && profile.signal_preferences.length > 0) {
      query = query.in('type', profile.signal_preferences);
    }

    const { data: signals } = await query;
    if (!signals || signals.length === 0) continue;

    // POINT 9: Group into "You have X signals" rather than spamming individual emails
    const signalHtml = signals.map(s => `
      <div style="margin-bottom: 20px; padding: 15px; border-left: 4px solid #4F46E5; background: #f9fafb;">
        <h3 style="margin: 0 0 10px 0;">${s.company_name}</h3>
        <p style="margin: 0 0 10px 0;">${s.signal_detail}</p>
        <p style="margin: 0; font-style: italic; color: #6b7280;">"${s.suggested_opener}"</p>
      </div>
    `).join('');

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ModelAtlas <hello@modelatlas.net>',
        to: profile.email,
        subject: `Your top ${signals.length} buying signals this week`,
        html: `
          <h2>Since your last visit...</h2>
          <p>Here are the top signals matching your ICP from the last 7 days:</p>
          ${signalHtml}
          <p><a href="https://modelatlas.net">See all your signals on ModelAtlas</a></p>
        `
      })
    });
    console.log(`Sent digest to ${profile.email}`);
  }
}

sendDigests().catch(console.error); 
