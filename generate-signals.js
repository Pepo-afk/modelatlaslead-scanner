const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ---------- SIGNAL DETECTION (unchanged) ----------
function getAddedText(oldText, newText) {
  if (!oldText) return newText || '';
  if (!newText) return '';
  const oldLines = new Set(oldText.split(/\n/).map(l => l.trim().toLowerCase()).filter(Boolean));
  const newLines = newText.split(/\n/).map(l => l.trim().toLowerCase()).filter(Boolean);
  return newLines.filter(line => !oldLines.has(line)).join(' ');
}

function detectFunding(text) {
  const lower = text.toLowerCase();
  let score = 0;
  const hasFundingWord = /\b(raised|funding|series [a-c]|investment|backed by|seed round)\b/i.test(lower);
  const hasAmount = /\$\d+[mMkKbB]?|\d+\s?(million|billion)/i.test(lower);
  if (hasFundingWord && hasAmount) score += 3;
  if (/\bseries [a-c]\b/i.test(lower) && hasAmount) score += 3;
  if (/\b(valuation|pre\-money|post\-money)\b/i.test(lower)) score += 2;
  return score >= 4;
}

function detectHiringSurge(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(we('re| are) hiring|now hiring|expanding (our |the )?team|join (our |the )?team|multiple openings|hiring spree)\b/i.test(lower)) score += 3;
  if (/\b(new|additional) (position|role|opening)/i.test(lower)) score += 1;
  if (/\b(growing (our |the )?(team|engineering|sales|marketing|support) (team|department|unit))\b/i.test(lower)) score += 2;
  if (lower.includes('careers') && !/\b(hiring|join|apply|openings)\b/i.test(lower)) score -= 1;
  return score >= 2;
}

function detectProductLaunch(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(introducing|announcing|unveil|launch(es|ed|ing)?|now available|new (product|feature|platform|integration))\b/i.test(lower)) score += 2;
  if (/\b(new (product|feature|platform|tool|app|dashboard|API))\b/i.test(lower)) score += 3;
  if (/\b(released|shipped|deployed|rolled out)\b/i.test(lower)) score += 2;
  if (/\blaunching soon\b/i.test(lower)) score -= 1;
  return score >= 3;
}

function detectPartnership(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(partner(ship|ing|s with)|integrat(es|ing|ed with)|collaborat(es|ing|ed with)|alliance with)\b/i.test(lower)) score += 2;
  if (/\b(together with|teaming up)\b/i.test(lower)) score += 1;
  return score >= 2;
}

function detectExpansion(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(new (office|location|city|country|region)|expanding (to|into)|now in [A-Z]|global expansion|opening (a|an) office)\b/i.test(lower)) score += 2;
  if (/\b(expanded|opening|launching) (in|across|into) [A-Z][a-z]+\b/i.test(lower)) score += 1;
  return score >= 2;
}

function detectRebranding(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(rebr?and|new (look|name|logo|identity)|refresh(ed)? (brand|logo|website))\b/i.test(lower)) score += 2;
  if (/\b(we are (now )?called|formerly known as|introducing our new (name|logo))\b/i.test(lower)) score += 3;
  return score >= 2;
}

function detectLeadershipChange(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(new (ceo|cto|cfo|coo|vp|director|head of)|appointed (ceo|cto|cfo)|hired as (ceo|cto|cfo))\b/i.test(lower)) score += 3;
  if (/\b(joined as|takes over as|promoted to)\b/i.test(lower)) score += 2;
  return score >= 3;
}

function getSignalsFromText(text, oldText = null) {
  const analysisText = oldText ? getAddedText(oldText, text) : text;
  if (!analysisText || analysisText.length < 30) return [];

  const detectors = {
    funding: detectFunding,
    hiring: detectHiringSurge,
    launch: detectProductLaunch,
    partnership: detectPartnership,
    expansion: detectExpansion,
    rebranding: detectRebranding,
    leadership: detectLeadershipChange,
  };

  const results = [];
  for (const [type, fn] of Object.entries(detectors)) {
    if (fn(analysisText)) results.push(type);
  }
  return results;
}

// ---------- CAP CHECK (20 days, with bypass) ----------
async function hasRecentSignal(leadId) {
  // Testing bypass – skip cap if DISABLE_CAP is set to "true"
  if (process.env.DISABLE_CAP === 'true') {
    console.log(`  CAP DISABLED – allowing signal for lead ${leadId}`);
    return false;
  }

  const twentyDaysAgo = new Date();
  twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);

  const { data, error } = await supabase
    .from('signals')
    .select('id')
    .eq('lead_id', leadId)
    .gte('detected_at', twentyDaysAgo.toISOString())
    .limit(1);

  if (error) {
    console.error(`Error checking recent signals for lead ${leadId}:`, error.message);
    return false; // fail safe
  }
  return data && data.length > 0;
}

// ---------- MAIN ----------
async function generateSignals() {
  console.log('Generating grouped signals (cap: 20 days)...');

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

  const companySignals = new Map();

  for (const page of changedPages) {
    const { data: snapshots } = await supabase
      .from('page_snapshots')
      .select('cleaned_text, fetched_at')
      .eq('company_page_id', page.id)
      .order('fetched_at', { ascending: false })
      .limit(2);

    if (!snapshots || snapshots.length === 0) {
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    const currentText = snapshots[0].cleaned_text || '';
    const previousText = snapshots.length > 1 ? snapshots[1].cleaned_text : null;

    const pageSignals = getSignalsFromText(currentText, previousText);
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
        console.error(`  Error inserting signal for lead ${lead.id}: ${insertError.message}`);
      } else {
        console.log(`  Created signal for lead ${lead.id}: ${description}`);
      }
    }
  }

  console.log('Signal generation complete.');
}

generateSignals().catch(console.error);
