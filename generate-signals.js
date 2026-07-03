const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ============================================================
// IMPROVED SIGNAL DETECTION ENGINE
// ============================================================

// ---------- HELPER: Get meaningful added text (diff) ----------
function getAddedText(oldText, newText) {
  if (!oldText) return newText || '';
  if (!newText) return '';

  // Simple diff: split into lines and find lines present in new but not old
  const oldLines = new Set(oldText.split(/\n/).map(l => l.trim().toLowerCase()).filter(Boolean));
  const newLines = newText.split(/\n/).map(l => l.trim().toLowerCase()).filter(Boolean);

  const added = newLines.filter(line => !oldLines.has(line));
  return added.join(' ');
}

// ---------- CONTEXT-AWARE RULES ----------
function detectFunding(text) {
  const lower = text.toLowerCase();
  let score = 0;

  // Must have a funding keyword near a dollar amount or "million/billion"
  const hasFundingWord = /\b(raised|funding|series [a-c]|investment|backed by|seed round)\b/i.test(lower);
  const hasAmount = /\$\d+[mMkKbB]?|\d+\s?(million|billion)/i.test(lower);

  if (hasFundingWord && hasAmount) score += 3;
  if (/\bseries [a-c]\b/i.test(lower) && hasAmount) score += 3;
  if (/\b(valuation|pre\-money|post\-money)\b/i.test(lower)) score += 2;

  return score >= 4;  // require strong evidence
}

function detectHiringSurge(text) {
  const lower = text.toLowerCase();
  let score = 0;

  // Direct hiring expansions, not just "Careers" page
  if (/\b(we('re| are) hiring|now hiring|expanding (our |the )?team|join (our |the )?team|multiple openings|hiring spree)\b/i.test(lower)) score += 3;
  if (/\b(new|additional) (position|role|opening)/i.test(lower)) score += 1;
  if (/\b(growing (our |the )?(team|engineering|sales|marketing|support) (team|department|unit))\b/i.test(lower)) score += 2;

  // Avoid false positives from static "Careers" nav (already removed, but double-check)
  // Negative points for isolated "careers" without action words
  if (lower.includes('careers') && !/\b(hiring|join|apply|openings)\b/i.test(lower)) score -= 1;

  return score >= 2;
}

function detectProductLaunch(text) {
  const lower = text.toLowerCase();
  let score = 0;

  // Product launch must be about a specific product, not generic "launching soon"
  if (/\b(introducing|announcing|unveil|launch(es|ed|ing)?|now available|new (product|feature|platform|integration))\b/i.test(lower)) score += 2;
  if (/\b(new (product|feature|platform|tool|app|dashboard|API))\b/i.test(lower)) score += 3;
  if (/\b(released|shipped|deployed|rolled out)\b/i.test(lower)) score += 2;

  // Penalise if it's just a "launch" button or placeholder
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

// ---------- MAIN SIGNAL CHECK ----------
function getSignalsFromText(text, oldText = null) {
  // Use only the added text if we have previous snapshot
  const analysisText = oldText ? getAddedText(oldText, text) : text;
  if (!analysisText || analysisText.length < 30) return [];  // too short to be meaningful

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

// ---------- ORCHESTRATION ----------
async function generateSignals() {
  console.log('Generating signals from changed pages...');

  // 1. Fetch changed pages that haven't been processed for signals yet
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

  for (const page of changedPages) {
    // Get the two most recent snapshots (current and previous) for diff
    const { data: snapshots } = await supabase
      .from('page_snapshots')
      .select('cleaned_text, fetched_at')
      .eq('company_page_id', page.id)
      .order('fetched_at', { ascending: false })
      .limit(2);

    if (!snapshots || snapshots.length === 0) {
      console.log(`No snapshot for ${page.page_url}, skipping.`);
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    const currentText = snapshots[0].cleaned_text || '';
    const previousText = snapshots.length > 1 ? snapshots[1].cleaned_text : null;

    const signalTypes = getSignalsFromText(currentText, previousText);
    if (signalTypes.length === 0) {
      console.log(`No meaningful signals on ${page.page_url}`);
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    console.log(`✅ Signals detected on ${page.page_url}: ${signalTypes.join(', ')}`);

    // Find all leads belonging to this company
    const { data: leads } = await supabase
      .from('leads')
      .select('id, user_id')
      .eq('company_name', page.companies.company_name)
      .eq('company_website', page.companies.website_url);

    if (!leads || leads.length === 0) {
      console.log(`No leads for ${page.companies.company_name}, skipping.`);
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      continue;
    }

    // Insert signals (avoid duplicates)
    for (const type of signalTypes) {
      for (const lead of leads) {
        const description = `${type} signal detected on ${page.page_type || 'page'}`;

        const { data: existing } = await supabase
          .from('signals')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('description', description)
          .eq('source_url', page.page_url)
          .maybeSingle();

        if (existing) {
          console.log(`  Duplicate signal for lead ${lead.id}, skipping.`);
          continue;
        }

        const { error: insertError } = await supabase.from('signals').insert({
          lead_id: lead.id,
          user_id: lead.user_id,
          type,
          description,
          source_url: page.page_url,
          email_status: 'pending',
          email_subject: `Update: ${page.companies.company_name}`
        });

        if (insertError) {
          console.error(`  Error inserting signal: ${insertError.message}`);
        } else {
          console.log(`  Created ${type} signal for lead ${lead.id}`);
        }
      }
    }

    // Mark page as processed
    await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
  }

  console.log('Signal generation complete.');
}

generateSignals().catch(console.error);
