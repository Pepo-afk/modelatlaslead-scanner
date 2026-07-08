const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ---------- FEEDBACK LEARNING ----------
async function getFeedbackRatio(type) {
  // Look at the last 50 signals of this type (using description)
  const { data: signals } = await supabase
    .from('signals')
    .select('id, description')
    .or(`type.eq.${type},description.ilike.%${type}%`)
    .order('detected_at', { ascending: false })
    .limit(50);

  if (!signals || signals.length === 0) return 1; // no data = neutral

  const signalIds = signals.map(s => s.id);

  const { data: feedbacks } = await supabase
    .from('signal_feedback')
    .select('rating')
    .in('signal_id', signalIds);

  if (!feedbacks || feedbacks.length === 0) return 1; // no feedback yet

  const good = feedbacks.filter(f => f.rating === 'good').length;
  const ratio = good / feedbacks.length;

  console.log(`  Feedback for type "${type}": ${good}/${feedbacks.length} good, ratio = ${ratio}`);
  return ratio;
}

async function adjustScore(type, originalScore) {
  const ratio = await getFeedbackRatio(type);

  if (ratio < 0.4) {
    // Less than 40% good → severely penalize
    return originalScore * 0.1;
  } else if (ratio < 0.6) {
    // Between 40-60% → moderate penalty
    return originalScore * 0.5;
  }
  // Above 60% → keep original score
  return originalScore;
}

// ---------- TEXT HELPERS ----------
function getAddedText(oldText, newText) {
  if (!oldText) return newText || '';
  if (!newText) return '';
  const oldLines = new Set(oldText.split(/\n/).map(l => l.trim().toLowerCase()).filter(Boolean));
  const newLines = newText.split(/\n/).map(l => l.trim().toLowerCase()).filter(Boolean);
  return newLines.filter(line => !oldLines.has(line)).join(' ');
}

function extractSnippet(text, signalTypes) {
  if (!text || signalTypes.length === 0) return '';
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const keywordMap = {
    funding: ['raised', 'funding', 'series a', 'series b', 'series c', 'investment', 'million', 'billion'],
    hiring: ['hiring', 'join us', "we're growing", 'now hiring', 'open positions', 'team'],
    launch: ['launch', 'introducing', 'new product', 'now available', 'released', 'announcing'],
    partnership: ['partnership', 'partner with', 'integrate', 'collaboration', 'alliance'],
    expansion: ['new office', 'expanding to', 'now in', 'new location', 'global expansion'],
    rebranding: ['rebrand', 'new look', 'new name', 'new logo', 'refresh'],
    leadership: ['new ceo', 'new cto', 'new cfo', 'appointed', 'hired as', 'takes over as'],
  };

  const relevant = sentences.filter(s => {
    const lower = s.toLowerCase();
    return signalTypes.some(type => (keywordMap[type] || []).some(word => lower.includes(word)));
  });

  return relevant.slice(0, 2).join('. ') || text.substring(0, 250);
}

// ---------- SIGNAL DETECTION (with learning) ----------
async function detectFunding(text) {
  const lower = text.toLowerCase();
  let score = 0;
  const hasFundingWord = /\b(raised|funding|series [a-c]|investment|backed by|seed round)\b/i.test(lower);
  const hasAmount = /\$\d+[mMkKbB]?|\d+\s?(million|billion)/i.test(lower);
  if (hasFundingWord && hasAmount) score += 3;
  if (/\bseries [a-c]\b/i.test(lower) && hasAmount) score += 3;
  if (/\b(valuation|pre\-money|post\-money)\b/i.test(lower)) score += 2;
  const threshold = await adjustScore('funding', 4);
  return score >= threshold;
}

async function detectHiringSurge(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(we('re| are) hiring|now hiring|expanding (our |the )?team|join (our |the )?team|multiple openings|hiring spree)\b/i.test(lower)) score += 3;
  if (/\b(new|additional) (position|role|opening)/i.test(lower)) score += 1;
  if (/\b(growing (our |the )?(team|engineering|sales|marketing|support) (team|department|unit))\b/i.test(lower)) score += 2;
  if (lower.includes('careers') && !/\b(hiring|join|apply|openings)\b/i.test(lower)) score -= 1;
  const threshold = await adjustScore('hiring', 2);
  return score >= threshold;
}

async function detectProductLaunch(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(introducing|announcing|unveil|launch(es|ed|ing)?|now available|new (product|feature|platform|integration))\b/i.test(lower)) score += 2;
  if (/\b(new (product|feature|platform|tool|app|dashboard|API))\b/i.test(lower)) score += 3;
  if (/\b(released|shipped|deployed|rolled out)\b/i.test(lower)) score += 2;
  if (/\blaunching soon\b/i.test(lower)) score -= 1;
  const threshold = await adjustScore('launch', 3);
  return score >= threshold;
}

async function detectPartnership(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(partner(ship|ing|s with)|integrat(es|ing|ed with)|collaborat(es|ing|ed with)|alliance with)\b/i.test(lower)) score += 2;
  if (/\b(together with|teaming up)\b/i.test(lower)) score += 1;
  const threshold = await adjustScore('partnership', 2);
  return score >= threshold;
}

async function detectExpansion(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(new (office|location|city|country|region)|expanding (to|into)|now in [A-Z]|global expansion|opening (a|an) office)\b/i.test(lower)) score += 2;
  if (/\b(expanded|opening|launching) (in|across|into) [A-Z][a-z]+\b/i.test(lower)) score += 1;
  const threshold = await adjustScore('expansion', 2);
  return score >= threshold;
}

async function detectRebranding(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(rebr?and|new (look|name|logo|identity)|refresh(ed)? (brand|logo|website))\b/i.test(lower)) score += 2;
  if (/\b(we are (now )?called|formerly known as|introducing our new (name|logo))\b/i.test(lower)) score += 3;
  const threshold = await adjustScore('rebranding', 2);
  return score >= threshold;
}

async function detectLeadershipChange(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (/\b(new (ceo|cto|cfo|coo|vp|director|head of)|appointed (ceo|cto|cfo)|hired as (ceo|cto|cfo))\b/i.test(lower)) score += 3;
  if (/\b(joined as|takes over as|promoted to)\b/i.test(lower)) score += 2;
  const threshold = await adjustScore('leadership', 3);
  return score >= threshold;
}

async function getSignalsFromText(text, oldText = null) {
  const analysisText = oldText ? getAddedText(oldText, text) : text;
  if (!analysisText || analysisText.length < 30) return [];

  const detectors = [
    { type: 'funding', fn: detectFunding },
    { type: 'hiring', fn: detectHiringSurge },
    { type: 'launch', fn: detectProductLaunch },
    { type: 'partnership', fn: detectPartnership },
    { type: 'expansion', fn: detectExpansion },
    { type: 'rebranding', fn: detectRebranding },
    { type: 'leadership', fn: detectLeadershipChange },
  ];

  const results = [];
  for (const { type, fn } of detectors) {
    if (await fn(analysisText)) {
      results.push(type);
    }
  }
  return results;
}

// ---------- HIRING SURGE CHECK ----------
async function checkHiringSurge(pageId) {
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

// ---------- MONTHLY CAP ----------
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

// ---------- MAIN ----------
async function generateSignals() {
  console.log('Generating detailed signals (with self‑learning)...');

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

  const companySignalsMap = new Map(); // company_id -> { signalTypes: Set, details: [] }

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

    // Text‑based signals (only if previous text exists)
    if (previousText) {
      pageSignals = await getSignalsFromText(currentText, previousText);
    }

    // Hiring surge check
    if (page.page_type === 'careers') {
      if (await checkHiringSurge(page.id)) {
        console.log(`  Hiring surge detected on ${page.page_url}`);
        pageSignals.push('hiring');
        const jobsNow = snapshots[0].job_count || 0;
        const jobsBefore = snapshots.length > 1 ? snapshots[1].job_count || 0 : 0;
        page._hiringDetail = `Job openings increased from ${jobsBefore} to ${jobsNow}.`;
      }
    }

    if (pageSignals.length === 0) {
      console.log(`No meaningful signals on ${page.page_url}`);
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    console.log(`✅ Signals on ${page.page_url}: ${pageSignals.join(', ')}`);

    // Build snippet
    const snippet = extractSnippet(currentText, pageSignals);
    const finalDetail = page._hiringDetail
      ? page._hiringDetail + ' ' + snippet
      : snippet;

    const companyId = page.company_id;
    if (!companySignalsMap.has(companyId)) {
      companySignalsMap.set(companyId, { signalTypes: new Set(), details: [] });
    }
    const entry = companySignalsMap.get(companyId);
    pageSignals.forEach(s => entry.signalTypes.add(s));
    if (finalDetail) {
      entry.details.push(finalDetail);
    }

    await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
  }

  // Create one grouped signal per company/lead
  for (const [companyId, data] of companySignalsMap.entries()) {
    const signalTypes = [...data.signalTypes];
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
    const signalDetail = data.details.join(' | ') || description;

    const emailSubject = `Update: ${company.company_name}`;

    for (const lead of leads) {
      if (await hasRecentSignal(lead.id)) {
        console.log(`  Skipping lead ${lead.id} – cap (20 days).`);
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
        signal_detail: signalDetail,
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
