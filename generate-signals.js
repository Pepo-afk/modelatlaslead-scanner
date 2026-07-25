const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

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

// ---------- FEEDBACK LEARNING (unchanged) ----------
async function getFeedbackRatio(type) { /* ... same as before ... */ }
async function adjustScore(type, originalThreshold) { /* ... same as before ... */ }
// I'll keep the full implementations from the last file – they are unchanged.

// (Including the whole file later – I'm summarizing the key change.)

// ---------- MAIN (with extensive logging and ALL PAGE TYPES allowed) ----------
async function generateSignals() {
  console.log('Generating signals (DIAGNOSTIC MODE – all page types included)...');

  // ... same scan run fetching ...

  // ----- Changed pages (no join) -----
  const { data: changedPages, error: pagesErr } = await supabase
    .from('company_pages')
    .select('id, page_url, page_type, company_id')
    .eq('last_status', 'changed')
    .eq('signals_generated', false);

  if (pagesErr) console.error('Error fetching changed pages:', pagesErr.message);
  else console.log(`Found ${changedPages?.length || 0} changed pages.`);

  // ----- Pending news -----
  const { data: newsEntries, error: newsErr } = await supabase
    .from('pending_news_signals')
    .select('id, company_id, article_url, title, snippet, pub_date');

  if (newsErr) console.error('Error fetching pending news:', newsErr.message);
  else console.log(`Found ${newsEntries?.length || 0} pending news articles.`);

  const companySignalsMap = new Map();

  function addSignalToCompany(...) { ... } // same

  // Process website changes
  if (changedPages && changedPages.length > 0) {
    for (const page of changedPages) {
      // Log every page we're about to process
      console.log(`  Processing page: ${page.page_url} (type: ${page.page_type})`);

      const { data: company } = await supabase
        .from('companies')
        .select('company_name, website_url')
        .eq('id', page.company_id)
        .single();

      if (!company) {
        console.log(`    ❌ Company not found for company_id ${page.company_id}, skipping.`);
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      // ----- TEMPORARY: allow ALL page types for diagnostic -----
      // (We'll add the filter back later)
      const allowedTypes = ['blog', 'news', 'press', 'homepage', 'careers', 'about', 'other']; // everything
      if (!allowedTypes.includes(page.page_type)) {
        console.log(`    Page type ${page.page_type} not in allowed list, skipping.`);
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      // Hiring surge check (only for careers)
      if (page.page_type === 'careers') {
        // ...
      }

      // Text analysis
      const { data: snapshots } = await supabase
        .from('page_snapshots')
        .select('cleaned_text')
        .eq('company_page_id', page.id)
        .order('fetched_at', { ascending: false })
        .limit(2);

      if (!snapshots || snapshots.length < 2) {
        console.log(`    Not enough snapshots (${snapshots?.length ?? 0}), skipping.`);
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      const currentText = snapshots[0].cleaned_text || '';
      const previousText = snapshots[1].cleaned_text || '';
      console.log(`    Previous text length: ${previousText.length}, current length: ${currentText.length}`);

      const textResults = await getSignalsFromText(currentText, previousText);
      if (textResults.length === 0) {
        console.log('    No text signals detected.');
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      // Confidence
      const totalRatio = textResults.reduce((sum, s) => sum + (s.score / s.threshold), 0);
      const avgRatio = totalRatio / textResults.length;
      let confidence = 'low';
      if (avgRatio >= 1.5) confidence = 'high';
      else if (avgRatio >= 1.0) confidence = 'medium';
      console.log(`    Text confidence: ${confidence} (avg ${avgRatio.toFixed(2)})`);

      if (confidence === 'low') {
        console.log('    Low confidence, skipping.');
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      // ... add signals, etc. (same as before)
    }
  }

  // Process news articles (add similar logs)
  // ...

  // ... rest of grouping and insertion ...
}

generateSignals().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
