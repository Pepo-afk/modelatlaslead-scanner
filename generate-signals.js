const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ---------- SIGNAL DETECTION (unchanged) ----------
function getAddedText(oldText, newText) { /* same as before */ }
function detectFunding(text) { /* ... */ }
function detectHiringSurgeText(text) { /* not used for numeric; renamed to avoid confusion */ }
function detectProductLaunch(text) { /* ... */ }
function detectPartnership(text) { /* ... */ }
function detectExpansion(text) { /* ... */ }
function detectRebranding(text) { /* ... */ }
function detectLeadershipChange(text) { /* ... */ }
function getSignalsFromText(text, oldText = null) { /* ... */ }

// (I'll keep the full detection functions for brevity; they are identical to the previous version. We'll include the new hiring check in the main loop.)

// ---------- MONTHLY CAP CHECK ----------
async function hasRecentSignal(leadId) {
  if (process.env.DISABLE_CAP === 'true') return false;
  const twentyDaysAgo = new Date();
  twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('lead_id', leadId)
    .gte('detected_at', twentyDaysAgo.toISOString())
    .limit(1);
  return data && data.length > 0;
}

// ---------- HIRING SURGE CHECK ----------
async function checkHiringSurge(pageId) {
  // Get the two most recent snapshots for this careers page
  const { data: snapshots } = await supabase
    .from('page_snapshots')
    .select('job_count, fetched_at')
    .eq('company_page_id', pageId)
    .order('fetched_at', { ascending: false })
    .limit(2);

  if (!snapshots || snapshots.length < 2) return false;
  const prev = snapshots[1].job_count;
  const curr = snapshots[0].job_count;
  return (prev !== null && curr !== null && (curr - prev) >= 5);
}

// ---------- MAIN GROUPED SIGNAL GENERATION ----------
async function generateSignals() {
  console.log('Generating grouped signals (with hiring surge)...');

  const { data: latestRun } = await supabase
    .from('scan_runs')
    .select('id')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();
  const scanRunId = latestRun?.id;
  if (!scanRunId) {
    console.log('No scan run found – run the scanner first.');
    return;
  }

  const { data: changedPages, error } = await supabase
    .from('company_pages')
    .select(`
      id,
      page_url,
      page_type,
      company_id,
      companies!inner(company_name, website_url)
    `)
    .eq('last_status', 'changed')
    .eq('signals_generated', false);

  if (error) {
    console.error('Error fetching changed pages:', error.message);
    return;
  }
  if (!changedPages || changedPages.length === 0) {
    console.log('No new changes to process.');
    return;
  }

  console.log(`Processing ${changedPages.length} changed pages...`);

  const companySignals = new Map(); // company_id -> Set of signal types

  for (const page of changedPages) {
    const { data: snapshots } = await supabase
      .from('page_snapshots')
      .select('cleaned_text, job_count, fetched_at')
      .eq('company_page_id', page.id)
      .order('fetched_at', { ascending: false })
      .limit(2);

    if (!snapshots || snapshots.length === 0) {
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    const currentText = snapshots[0].cleaned_text || '';
    const previousText = snapshots.length > 1 ? snapshots[1].cleaned_text : null;
    let pageSignals = [];

    // Text-based signals (only if previous text exists)
    if (previousText) {
      pageSignals = getSignalsFromText(currentText, previousText);
    }

    // Hiring surge check (careers pages)
    if (page.page_type === 'careers') {
      if (await checkHiringSurge(page.id)) {
        console.log(`  Hiring surge detected on ${page.page_url}`);
        pageSignals.push('hiring');
      }
    }

    // (Future: blog post detection can be added similarly)

    if (pageSignals.length === 0) {
      console.log(`No meaningful signals on ${page.page_url}`);
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    console.log(`✅ Signals on ${page.page_url}: ${pageSignals.join(', ')}`);

    const companyId = page.company_id;
    if (!companySignals.has(companyId)) {
      companySignals.set(companyId, new Set());
    }
    pageSignals.forEach(s => companySignals.get(companyId).add(s));

    await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
  }

  // Group and insert signals (with cap)
  for (const [companyId, signalTypesSet] of companySignals.entries()) {
    const signalTypes = [...signalTypesSet];
    if (signalTypes.length === 0) continue;

    const { data: company } = await supabase
      .from('companies')
      .select('company_name, website_url')
      .eq('id', companyId)
      .single();
    if (!company) continue;

    const { data: leads } = await supabase
      .from('leads')
      .select('id, user_id')
      .eq('company_name', company.company_name)
      .eq('company_website', company.website_url);
    if (!leads || leads.length === 0) continue;

    const description = `Signals detected: ${signalTypes.join(', ')}`;
    const emailSubject = `Update: ${company.company_name}`;

    for (const lead of leads) {
      if (await hasRecentSignal(lead.id)) {
        console.log(`  Skipping lead ${lead.id} – signal already sent within 20 days.`);
        continue;
      }

      const { data: existing } = await supabase
        .from('signals')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('description', description)
        .gte('detected_at', new Date().toISOString().split('T')[0])
        .maybeSingle();

      if (existing) {
        console.log(`  Duplicate for lead ${lead.id} today, skipping.`);
        continue;
      }

      const { error: insertError } = await supabase.from('signals').insert({
        lead_id: lead.id,
        user_id: lead.user_id,
        type: 'multi',
        description,
        source_url: company.website_url,
        email_status: 'pending',
        email_subject: emailSubject,
        scan_run_id: scanRunId
      });

      if (insertError) {
        console.error(`  Error inserting signal: ${insertError.message}`);
      } else {
        console.log(`  Created signal for lead ${lead.id}: ${description}`);
      }
    }
  }

  console.log('Signal generation complete.');
}

generateSignals().catch(console.error); 
