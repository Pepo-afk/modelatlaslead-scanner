const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ---------- WORD-LEVEL LEARNING DATA ----------
let wordWeights = new Map(); // word -> multiplier (1 = neutral)

async function loadWordWeights() {
  const { data, error } = await supabase
    .from('word_feedback')
    .select('word, good, bad');
  if (error) {
    console.error('Failed to load word feedback:', error.message);
    return;
  }
  wordWeights.clear();
  for (const row of data || []) {
    const total = row.good + row.bad;
    if (total === 0) continue;
    const ratio = row.good / total;
    if (ratio < 0.3) wordWeights.set(row.word, 0.1);
    else if (ratio < 0.5) wordWeights.set(row.word, 0.5);
    else wordWeights.set(row.word, 1.0);
  }
  console.log(`Loaded ${wordWeights.size} word weights.`);
}

function getWordWeight(word) {
  return wordWeights.get(word) ?? 1.0;
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

// ---------- FEEDBACK LEARNING (category thresholds) ----------
async function getFeedbackRatio(type) {
  const { data: signals } = await supabase
    .from('signals')
    .select('id, description')
    .or(`type.eq.${type},description.ilike.%${type}%`)
    .order('detected_at', { ascending: false })
    .limit(50);
  if (!signals || signals.length === 0) return { ratio: 1, count: 0 };
  const signalIds = signals.map(s => s.id);
  const { data: feedbacks } = await supabase
    .from('signal_feedback')
    .select('rating')
    .in('signal_id', signalIds);
  if (!feedbacks || feedbacks.length === 0) return { ratio: 1, count: 0 };
  const good = feedbacks.filter(f => f.rating === 'good').length;
  return { ratio: good / feedbacks.length, count: feedbacks.length };
}

async function adjustScore(type, originalThreshold) {
  const { ratio, count } = await getFeedbackRatio(type);
  if (count < 10) return originalThreshold;
  if (ratio < 0.3) return originalThreshold * 1.5;
  if (ratio < 0.5) return originalThreshold * 1.2;
  return originalThreshold;
}

// ---------- DETECTION FUNCTIONS (per-word weighted scoring) ----------
// Each returns { triggered, score, threshold, matchedWords }

async function detectFunding(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'announced', points: 2 },
    { phrase: 'closes', points: 2 },
    { phrase: 'closed', points: 2 },
    { phrase: 'raises', points: 2 },
    { phrase: 'raised', points: 2 },
    { phrase: 'secures', points: 2 },
    { phrase: 'secured', points: 2 },
    { phrase: 'just raised', points: 3 },
    { phrase: 'today announces', points: 3 },
    { phrase: 'announced today', points: 3 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  // Amount pattern (non-weightable, always full points)
  const hasAmount = /\$\d+[mMkKbB]?|\d+\s?(million|billion)/i.test(lower);
  if (hasAmount) {
    score += 3;
    matched.push('AMOUNT_PATTERN');
  }
  // Recent date bonus
  if (/\b(today|yesterday|this week|this month)\b/i.test(lower)) score += 1;
  // Penalty for old year
  const currentYear = new Date().getFullYear();
  const yearMatch = lower.match(/\b(20\d{2})\b/g);
  if (yearMatch) {
    const recentYears = yearMatch.filter(y => parseInt(y) >= currentYear - 1);
    if (recentYears.length === 0 && yearMatch.length > 0) score -= 3;
  }
  let threshold = 5;
  threshold = await adjustScore('funding', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectHiringSurgeText(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: "we're hiring", points: 3 },
    { phrase: 'we are hiring', points: 3 },
    { phrase: 'now hiring', points: 3 },
    { phrase: 'expanding our team', points: 3 },
    { phrase: 'expanding the team', points: 3 },
    { phrase: 'join our team', points: 3 },
    { phrase: 'join the team', points: 3 },
    { phrase: 'multiple openings', points: 3 },
    { phrase: 'hiring spree', points: 3 },
    { phrase: 'new position', points: 1 },
    { phrase: 'additional position', points: 1 },
    { phrase: 'new role', points: 1 },
    { phrase: 'additional role', points: 1 },
    { phrase: 'growing our team', points: 2 },
    { phrase: 'growing the team', points: 2 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  // penalize isolated "careers" without action
  if (lower.includes('careers') && !/\b(hiring|join|apply|openings)\b/i.test(lower)) score -= 1;
  let threshold = 3;
  threshold = await adjustScore('hiring', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectProductLaunch(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'introducing', points: 2 },
    { phrase: 'announcing', points: 2 },
    { phrase: 'unveil', points: 2 },
    { phrase: 'launch', points: 2 },
    { phrase: 'launched', points: 2 },
    { phrase: 'launches', points: 2 },
    { phrase: 'launching', points: 2 },
    { phrase: 'now available', points: 2 },
    { phrase: 'new product', points: 3 },
    { phrase: 'new feature', points: 3 },
    { phrase: 'new platform', points: 3 },
    { phrase: 'new tool', points: 3 },
    { phrase: 'new app', points: 3 },
    { phrase: 'new dashboard', points: 3 },
    { phrase: 'new API', points: 3 },
    { phrase: 'released', points: 2 },
    { phrase: 'shipped', points: 2 },
    { phrase: 'deployed', points: 2 },
    { phrase: 'rolled out', points: 2 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  if (/\blaunching soon\b/i.test(lower)) score -= 1;
  let threshold = 5;
  threshold = await adjustScore('launch', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectPartnership(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'partnership', points: 2 },
    { phrase: 'partnering', points: 2 },
    { phrase: 'partners with', points: 2 },
    { phrase: 'partner with', points: 2 },
    { phrase: 'integrates with', points: 2 },
    { phrase: 'integrating with', points: 2 },
    { phrase: 'integrated with', points: 2 },
    { phrase: 'collaborates with', points: 2 },
    { phrase: 'collaborating with', points: 2 },
    { phrase: 'collaborated with', points: 2 },
    { phrase: 'alliance with', points: 2 },
    { phrase: 'together with', points: 1 },
    { phrase: 'teaming up', points: 1 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  let threshold = 3;
  threshold = await adjustScore('partnership', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectExpansion(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'new office', points: 2 },
    { phrase: 'new location', points: 2 },
    { phrase: 'new city', points: 2 },
    { phrase: 'new country', points: 2 },
    { phrase: 'new region', points: 2 },
    { phrase: 'expanding to', points: 2 },
    { phrase: 'expanding into', points: 2 },
    { phrase: 'now in', points: 2 },
    { phrase: 'global expansion', points: 2 },
    { phrase: 'opening an office', points: 2 },
    { phrase: 'opening a office', points: 2 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  let threshold = 4;
  threshold = await adjustScore('expansion', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectRebranding(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'rebrand', points: 2 },
    { phrase: 'new look', points: 2 },
    { phrase: 'new name', points: 2 },
    { phrase: 'new logo', points: 2 },
    { phrase: 'new identity', points: 2 },
    { phrase: 'refreshed brand', points: 2 },
    { phrase: 'refreshed logo', points: 2 },
    { phrase: 'refreshed website', points: 2 },
    { phrase: 'we are now called', points: 3 },
    { phrase: 'formerly known as', points: 3 },
    { phrase: 'introducing our new name', points: 3 },
    { phrase: 'introducing our new logo', points: 3 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  let threshold = 4;
  threshold = await adjustScore('rebranding', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectLeadershipChange(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'new ceo', points: 3 },
    { phrase: 'new cto', points: 3 },
    { phrase: 'new cfo', points: 3 },
    { phrase: 'new coo', points: 3 },
    { phrase: 'new vp', points: 3 },
    { phrase: 'new director', points: 3 },
    { phrase: 'new head of', points: 3 },
    { phrase: 'appointed', points: 3 },
    { phrase: 'hired as', points: 3 },
    { phrase: 'joined as', points: 2 },
    { phrase: 'takes over as', points: 2 },
    { phrase: 'promoted to', points: 2 },
  ];
  let score = 0;
  const matched = [];
  for (const kw of keywords) {
    if (lower.includes(kw.phrase)) {
      const weight = getWordWeight(kw.phrase);
      score += kw.points * weight;
      matched.push(kw.phrase);
    }
  }
  let threshold = 5;
  threshold = await adjustScore('leadership', threshold);
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function getSignalsFromText(text, oldText = null) {
  const analysisText = oldText ? getAddedText(oldText, text) : text;
  if (!analysisText || analysisText.length < 30) return [];
  const detectors = [
    { type: 'funding', fn: detectFunding },
    { type: 'hiring', fn: detectHiringSurgeText },
    { type: 'launch', fn: detectProductLaunch },
    { type: 'partnership', fn: detectPartnership },
    { type: 'expansion', fn: detectExpansion },
    { type: 'rebranding', fn: detectRebranding },
    { type: 'leadership', fn: detectLeadershipChange },
  ];
  const results = [];
  for (const { type, fn } of detectors) {
    const res = await fn(analysisText);
    if (res.triggered) {
      results.push({
        type: type,
        score: res.score,
        threshold: res.threshold,
        matchedWords: res.matchedWords
      });
    }
  }
  return results;
}

// ---------- HIRING SURGE CHECK (numeric, unchanged) ----------
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
  console.log('Generating signals with per-word learning...');

  // Load word weights at start
  await loadWordWeights();

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

  // ----- Changed pages -----
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

  function addSignalToCompany(companyId, companyName, websiteUrl, type, detail, sourceObj, words) {
    if (!companySignalsMap.has(companyId)) {
      companySignalsMap.set(companyId, {
        companyName,
        websiteUrl,
        signalTypes: new Set(),
        details: [],
        sources: [],
        triggeredWords: new Set()
      });
    }
    const entry = companySignalsMap.get(companyId);
    entry.signalTypes.add(type);
    if (detail) entry.details.push(detail);
    if (sourceObj) entry.sources.push(sourceObj);
    if (words) words.forEach(w => entry.triggeredWords.add(w));
  }

  // ------- Process website changes -------
  if (changedPages && changedPages.length > 0) {
    for (const page of changedPages) {
      console.log(`\n  Processing page: ${page.page_url} (type: ${page.page_type})`);

      const { data: company } = await supabase
        .from('companies')
        .select('company_name, website_url')
        .eq('id', page.company_id)
        .single();

      if (!company) {
        console.log('    ❌ Company not found, skipping.');
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      // Allow all page types for now
      const allowedTypes = ['blog', 'news', 'press', 'homepage', 'careers', 'about', 'other'];
      if (!allowedTypes.includes(page.page_type)) {
        console.log(`    Page type ${page.page_type} not allowed.`);
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      // Hiring surge
      if (page.page_type === 'careers') {
        if (await checkHiringSurge(page.id)) {
          const { data: snapshots } = await supabase
            .from('page_snapshots')
            .select('job_count')
            .eq('company_page_id', page.id)
            .order('fetched_at', { ascending: false })
            .limit(2);
          const now = snapshots?.[0]?.job_count || 0;
          const before = snapshots?.[1]?.job_count || 0;
          addSignalToCompany(page.company_id, company.company_name, company.website_url,
            'hiring', `Job openings increased from ${before} to ${now}.`,
            { label: 'Careers page', url: page.page_url },
            ['hiring_surge']  // special word for numeric surge
          );
          console.log('    ✅ Hiring surge.');
        }
      }

      // Text analysis
      const { data: snapshots } = await supabase
        .from('page_snapshots')
        .select('cleaned_text')
        .eq('company_page_id', page.id)
        .order('fetched_at', { ascending: false })
        .limit(2);

      if (!snapshots || snapshots.length < 2) {
        console.log(`    Not enough snapshots, skipping.`);
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      const currentText = snapshots[0].cleaned_text || '';
      const previousText = snapshots[1].cleaned_text || '';
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

      if (page.page_type === 'homepage' && textResults.length < 2) {
        console.log('    Homepage with only one signal type, skipping.');
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      const snippet = extractSnippet(currentText, textResults.map(s => s.type));
      textResults.forEach(s => addSignalToCompany(
        page.company_id, company.company_name, company.website_url,
        s.type, snippet,
        { label: `${page.page_type}: ${page.page_url}`, url: page.page_url },
        s.matchedWords
      ));
      console.log('    ✅ Signals added.');

      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
    }
  }

  // ------- Process news articles -------
  if (newsEntries && newsEntries.length > 0) {
    for (const news of newsEntries) {
      console.log(`\n  Processing news: ${news.title.substring(0, 60)}...`);

      const { data: company } = await supabase
        .from('companies')
        .select('company_name, website_url')
        .eq('id', news.company_id)
        .single();

      if (!company) {
        console.log('    ❌ Company not found, skipping.');
        continue;
      }

      const text = `${news.title} ${news.snippet}`;
      const textResults = await getSignalsFromText(text, null);
      if (textResults.length === 0) {
        console.log('    No signals in news article.');
        continue;
      }

      const totalRatio = textResults.reduce((sum, s) => sum + (s.score / s.threshold), 0);
      const avgRatio = totalRatio / textResults.length;
      let confidence = 'low';
      if (avgRatio >= 1.5) confidence = 'high';
      else if (avgRatio >= 1.0) confidence = 'medium';
      console.log(`    Confidence: ${confidence} (avg ${avgRatio.toFixed(2)})`);

      if (confidence === 'low') continue;

      const snippet = extractSnippet(text, textResults.map(s => s.type));
      textResults.forEach(s => addSignalToCompany(
        news.company_id, company.company_name, company.website_url,
        s.type, snippet,
        { label: `News: ${news.title}`, url: news.article_url },
        s.matchedWords
      ));
      console.log('    ✅ Signals added from news.');
    }
  }

  // ------- Create grouped signals -------
  for (const [companyId, data] of companySignalsMap.entries()) {
    const signalTypes = [...data.signalTypes];
    if (signalTypes.length === 0) continue;

    const { data: leads } = await supabase
      .from('leads')
      .select('id, user_id')
      .eq('company_name', data.companyName)
      .eq('company_website', data.websiteUrl);
    if (!leads || leads.length === 0) {
      console.log(`  No leads for ${data.companyName}.`);
      continue;
    }

    const description = `Signals detected: ${signalTypes.join(', ')}`;
    const signalDetail = data.details.join(' | ') || description;
    const sourceUrls = data.sources;
    const triggeredWords = [...data.triggeredWords];

    for (const lead of leads) {
      if (await hasRecentSignal(lead.id)) {
        console.log(`  Lead ${lead.id} blocked by 20-day cap.`);
        continue;
      }

      const { error: insertError } = await supabase.from('signals').insert({
        lead_id: lead.id,
        user_id: lead.user_id,
        type: 'multi',
        description,
        signal_detail: signalDetail,
        source_url: data.websiteUrl,
        source_urls: sourceUrls,
        triggered_words: triggeredWords,
        email_status: 'pending',
        email_subject: `Update: ${data.companyName}`,
        scan_run_id: scanRunId
      });

      if (insertError) {
        console.error(`  Error inserting signal: ${insertError.message}`);
      } else {
        console.log(`  ✅ Signal created for lead ${lead.id} (words: ${triggeredWords.join(', ')})`);
      }
    }
  }

  // Delete processed news
  if (newsEntries && newsEntries.length > 0) {
    const idsToDelete = newsEntries.map(n => n.id);
    await supabase.from('pending_news_signals').delete().in('id', idsToDelete);
  }

  console.log('Signal generation complete.');
}

generateSignals().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
