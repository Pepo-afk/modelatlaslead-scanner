const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CHUNK_SIZE = 10;   // items per AI request

// ---------- WORD-LEVEL LEARNING DATA ----------
let wordWeights = new Map();

async function loadWordWeights() {
  const { data, error } = await supabase
    .from('word_feedback')
    .select('word, good, bad, ai_good, ai_bad');
  if (error) {
    console.error('Failed to load word feedback:', error.message);
    return;
  }
  wordWeights.clear();
  for (const row of data || []) {
    const totalUser = row.good + row.bad;
    const totalAI = (row.ai_good || 0) + (row.ai_bad || 0);
    const weightedGood = (row.good * 3) + (row.ai_good || 0);
    const weightedTotal = (totalUser * 3) + totalAI;
    if (weightedTotal === 0) continue;
    const ratio = weightedGood / weightedTotal;
    if (ratio < 0.3) wordWeights.set(row.word, 0.1);
    else if (ratio < 0.5) wordWeights.set(row.word, 0.5);
    else wordWeights.set(row.word, 1.0);
  }
  console.log(`Loaded ${wordWeights.size} word weights (combined user+AI).`);
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

// ---------- KEYWORD DETECTION FUNCTIONS (per-word weighted) ----------
async function detectFunding(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'announced', points: 2 }, { phrase: 'closes', points: 2 }, { phrase: 'closed', points: 2 },
    { phrase: 'raises', points: 2 }, { phrase: 'raised', points: 2 }, { phrase: 'secures', points: 2 },
    { phrase: 'secured', points: 2 }, { phrase: 'just raised', points: 3 }, { phrase: 'today announces', points: 3 },
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
  const hasAmount = /\$\d+[mMkKbB]?|\d+\s?(million|billion)/i.test(lower);
  if (hasAmount) { score += 3; matched.push('AMOUNT_PATTERN'); }
  if (/\b(today|yesterday|this week|this month)\b/i.test(lower)) score += 1;
  const currentYear = new Date().getFullYear();
  const yearMatch = lower.match(/\b(20\d{2})\b/g);
  if (yearMatch) {
    const recentYears = yearMatch.filter(y => parseInt(y) >= currentYear - 1);
    if (recentYears.length === 0 && yearMatch.length > 0) score -= 3;
  }
  const threshold = 5;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectHiringSurgeText(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: "we're hiring", points: 3 }, { phrase: 'we are hiring', points: 3 },
    { phrase: 'now hiring', points: 3 }, { phrase: 'expanding our team', points: 3 },
    { phrase: 'expanding the team', points: 3 }, { phrase: 'join our team', points: 3 },
    { phrase: 'join the team', points: 3 }, { phrase: 'multiple openings', points: 3 },
    { phrase: 'hiring spree', points: 3 }, { phrase: 'new position', points: 1 },
    { phrase: 'additional position', points: 1 }, { phrase: 'new role', points: 1 },
    { phrase: 'additional role', points: 1 }, { phrase: 'growing our team', points: 2 },
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
  if (lower.includes('careers') && !/\b(hiring|join|apply|openings)\b/i.test(lower)) score -= 1;
  const threshold = 3;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectProductLaunch(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'introducing', points: 2 }, { phrase: 'announcing', points: 2 },
    { phrase: 'unveil', points: 2 }, { phrase: 'launch', points: 2 },
    { phrase: 'launched', points: 2 }, { phrase: 'launches', points: 2 },
    { phrase: 'launching', points: 2 }, { phrase: 'now available', points: 2 },
    { phrase: 'new product', points: 3 }, { phrase: 'new feature', points: 3 },
    { phrase: 'new platform', points: 3 }, { phrase: 'new tool', points: 3 },
    { phrase: 'new app', points: 3 }, { phrase: 'new dashboard', points: 3 },
    { phrase: 'new API', points: 3 }, { phrase: 'released', points: 2 },
    { phrase: 'shipped', points: 2 }, { phrase: 'deployed', points: 2 },
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
  const threshold = 5;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectPartnership(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'partnership', points: 2 }, { phrase: 'partnering', points: 2 },
    { phrase: 'partners with', points: 2 }, { phrase: 'partner with', points: 2 },
    { phrase: 'integrates with', points: 2 }, { phrase: 'integrating with', points: 2 },
    { phrase: 'integrated with', points: 2 }, { phrase: 'collaborates with', points: 2 },
    { phrase: 'collaborating with', points: 2 }, { phrase: 'collaborated with', points: 2 },
    { phrase: 'alliance with', points: 2 }, { phrase: 'together with', points: 1 },
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
  const threshold = 3;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectExpansion(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'new office', points: 2 }, { phrase: 'new location', points: 2 },
    { phrase: 'new city', points: 2 }, { phrase: 'new country', points: 2 },
    { phrase: 'new region', points: 2 }, { phrase: 'expanding to', points: 2 },
    { phrase: 'expanding into', points: 2 }, { phrase: 'now in', points: 2 },
    { phrase: 'global expansion', points: 2 }, { phrase: 'opening an office', points: 2 },
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
  const threshold = 4;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectRebranding(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'rebrand', points: 2 }, { phrase: 'new look', points: 2 },
    { phrase: 'new name', points: 2 }, { phrase: 'new logo', points: 2 },
    { phrase: 'new identity', points: 2 }, { phrase: 'refreshed brand', points: 2 },
    { phrase: 'refreshed logo', points: 2 }, { phrase: 'refreshed website', points: 2 },
    { phrase: 'we are now called', points: 3 }, { phrase: 'formerly known as', points: 3 },
    { phrase: 'introducing our new name', points: 3 }, { phrase: 'introducing our new logo', points: 3 },
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
  const threshold = 4;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function detectLeadershipChange(text) {
  const lower = text.toLowerCase();
  const keywords = [
    { phrase: 'new ceo', points: 3 }, { phrase: 'new cto', points: 3 },
    { phrase: 'new cfo', points: 3 }, { phrase: 'new coo', points: 3 },
    { phrase: 'new vp', points: 3 }, { phrase: 'new director', points: 3 },
    { phrase: 'new head of', points: 3 }, { phrase: 'appointed', points: 3 },
    { phrase: 'hired as', points: 3 }, { phrase: 'joined as', points: 2 },
    { phrase: 'takes over as', points: 2 }, { phrase: 'promoted to', points: 2 },
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
  const threshold = 5;
  return { triggered: score >= threshold, score, threshold, matchedWords: matched };
}

async function getSignalsFromTextKeyword(text, oldText = null) {
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
    if (res.triggered) results.push({ type, score: res.score, threshold: res.threshold, matchedWords: res.matchedWords });
  }
  return results;
}

// ---------- HIRING SURGE (numeric) ----------
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

// ---------- DIRECT OPENROUTER CALL (with retry on 429) ----------
async function callOpenRouter(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });

      if (response.status === 429) {
        console.warn(`  Rate limited (429) on attempt ${attempt}, retrying in 10s...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${errText}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  Request failed on attempt ${attempt}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  throw new Error('All retries exhausted');
}

async function batchDetectSignals(items) {
  let combinedResult = {};
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const prompt = buildBatchPrompt(chunk);
    try {
      const content = await callOpenRouter(prompt);
      const chunkResult = JSON.parse(content);
      Object.assign(combinedResult, chunkResult);
    } catch (err) {
      console.error(`Chunk ${i} failed:`, err.message);
      return null;   // fallback to keyword engine
    }
  }
  return combinedResult;
}

function buildBatchPrompt(items) {
  let prompt = "You are an assistant that reads web page text and detects business signals a B2B salesperson would care about.\n\n";
  prompt += "Signals: funding, hiring, launch, partnership, expansion, rebranding, leadership.\n";
  prompt += "Below are multiple pieces of text, each with an ID. For each one, decide if it describes a specific, recent event matching any signal type. If so, list the signal types and a short explanation. If the text is just a menu, historical timeline, educational article, or boilerplate, return empty signals.\n\n";

  for (const item of items) {
    const id = item.id;
    const type = item.type ?? 'page';
    const text = item.text.substring(0, 1500);
    prompt += `ID: ${id}\nType: ${type}\nText:\n${text}\n\n`;
  }

  prompt += "Return a JSON object where each key is an ID, and the value is an object with \"signals\" (array of strings) and \"explanation\" (string). If no signals, use empty array and empty string.\n";
  prompt += "Only return the JSON object, no other text.";
  return prompt;
}

// ---------- AI FEEDBACK LEARNING ----------
async function applyAIFeedback(itemMeta, aiResult) {
  const adjustments = new Map();
  function addAdjustment(word, field) {
    if (!adjustments.has(word)) adjustments.set(word, { ai_good: 0, ai_bad: 0 });
    const entry = adjustments.get(word);
    entry[field] += 1;
  }

  for (const [itemId, meta] of Object.entries(itemMeta)) {
    if (!meta.keywordResults || meta.keywordResults.length === 0) continue;
    const aiSignals = (aiResult && aiResult[itemId]) ? aiResult[itemId].signals : [];

    for (const kwResult of meta.keywordResults) {
      const type = kwResult.type;
      const aiAgreed = aiSignals.includes(type);
      const words = kwResult.matchedWords || [];
      for (const word of words) {
        if (aiAgreed) addAdjustment(word, 'ai_good');
        else addAdjustment(word, 'ai_bad');
      }
    }
  }

  for (const [word, adj] of adjustments.entries()) {
    const { data: existing } = await supabase
      .from('word_feedback')
      .select('good, bad, ai_good, ai_bad')
      .eq('word', word)
      .maybeSingle();

    const row = existing || { good: 0, bad: 0, ai_good: 0, ai_bad: 0 };
    await supabase
      .from('word_feedback')
      .upsert({
        word,
        good: row.good,
        bad: row.bad,
        ai_good: (row.ai_good || 0) + adj.ai_good,
        ai_bad: (row.ai_bad || 0) + adj.ai_bad
      }, { onConflict: 'word' });
  }
  console.log(`AI feedback applied for ${adjustments.size} words.`);
}

// ---------- MAIN ----------
async function generateSignals() {
  console.log('Generating signals (direct AI call, retry on 429)...');

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
  const { data: changedPages } = await supabase
    .from('company_pages')
    .select('id, page_url, page_type, company_id')
    .eq('last_status', 'changed')
    .eq('signals_generated', false);

  // ----- Pending news -----
  const { data: newsEntries } = await supabase
    .from('pending_news_signals')
    .select('id, company_id, article_url, title, snippet, pub_date');

  console.log(`Found ${changedPages?.length || 0} changed pages, ${newsEntries?.length || 0} news.`);

  const aiItems = [];
  const itemMeta = {};

  // Process pages
  if (changedPages && changedPages.length > 0) {
    for (const page of changedPages) {
      const { data: snap } = await supabase
        .from('page_snapshots')
        .select('cleaned_text')
        .eq('company_page_id', page.id)
        .order('fetched_at', { ascending: false })
        .limit(2);

      if (!snap || snap.length < 2) {
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      const currentText = snap[0].cleaned_text || '';
      const previousText = snap[1].cleaned_text || '';
      const keywordResults = await getSignalsFromTextKeyword(currentText, previousText);

      let hasHiringSurge = false;
      if (page.page_type === 'careers') {
        hasHiringSurge = await checkHiringSurge(page.id);
      }

      if (keywordResults.length === 0 && !hasHiringSurge) {
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      const itemId = `page-${page.id}`;
      itemMeta[itemId] = { type: 'page', page, keywordResults, hasHiringSurge };

      if (keywordResults.length > 0) {
        aiItems.push({ id: itemId, type: 'page', text: currentText });
      }
    }
  }

  // Process news
  if (newsEntries && newsEntries.length > 0) {
    for (const news of newsEntries) {
      const text = `${news.title} ${news.snippet}`;
      const keywordResults = await getSignalsFromTextKeyword(text, null);
      if (keywordResults.length === 0) continue;

      const itemId = `news-${news.id}`;
      aiItems.push({ id: itemId, type: 'news', text });
      itemMeta[itemId] = { type: 'news', news, keywordResults };
    }
  }

  // Batch AI call (direct, chunked, with retry)
  let aiResult = null;
  if (aiItems.length > 0) {
    aiResult = await batchDetectSignals(aiItems);
    if (!aiResult) {
      console.log('Batch AI failed, falling back to keyword engine.');
    } else {
      await applyAIFeedback(itemMeta, aiResult);
    }
  }

  const companySignalsMap = new Map();

  function addSignalToCompany(companyId, companyName, websiteUrl, type, explanation, sourceObj, words) {
    if (!companySignalsMap.has(companyId)) {
      companySignalsMap.set(companyId, {
        companyName,
        websiteUrl,
        signalTypes: new Set(),
        explanations: [],
        sources: [],
        triggeredWords: new Set()
      });
    }
    const entry = companySignalsMap.get(companyId);
    entry.signalTypes.add(type);
    if (explanation) entry.explanations.push(explanation);
    if (sourceObj) entry.sources.push(sourceObj);
    if (words) words.forEach(w => entry.triggeredWords.add(w));
  }

  // Process all items (AI‑validated or fallback)
  for (const [itemId, meta] of Object.entries(itemMeta)) {
    if (meta.type === 'page') {
      const page = meta.page;
      const { data: company } = await supabase
        .from('companies')
        .select('company_name, website_url')
        .eq('id', page.company_id)
        .single();
      if (!company) continue;

      // Hiring surge (always added)
      if (meta.hasHiringSurge) {
        const { data: snapJob } = await supabase
          .from('page_snapshots')
          .select('job_count')
          .eq('company_page_id', page.id)
          .order('fetched_at', { ascending: false })
          .limit(2);
        const now = snapJob?.[0]?.job_count || 0;
        const before = snapJob?.[1]?.job_count || 0;
        addSignalToCompany(page.company_id, company.company_name, company.website_url,
          'hiring', `Job openings increased from ${before} to ${now}.`,
          { label: 'Careers page', url: page.page_url },
          ['hiring_surge']);
      }

      // Text signals from AI or keyword fallback
      if (aiResult && aiResult[itemId]) {
        const aiSignals = aiResult[itemId].signals;
        if (aiSignals.length > 0) {
          console.log(`  AI signals for ${page.page_url}: ${aiSignals.join(', ')}`);
          for (const type of aiSignals) {
            addSignalToCompany(page.company_id, company.company_name, company.website_url,
              type, aiResult[itemId].explanation,
              { label: `${page.page_type}: ${page.page_url}`, url: page.page_url },
              meta.keywordResults.flatMap(r => r.matchedWords || []));
          }
        }
      } else {
        // Keyword fallback
        for (const res of meta.keywordResults) {
          addSignalToCompany(page.company_id, company.company_name, company.website_url,
            res.type, `Keyword match: ${res.matchedWords.join(', ')}`,
            { label: `${page.page_type}: ${page.page_url}`, url: page.page_url },
            res.matchedWords);
        }
      }

      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
    } else if (meta.type === 'news') {
      const news = meta.news;
      const { data: company } = await supabase
        .from('companies')
        .select('company_name, website_url')
        .eq('id', news.company_id)
        .single();
      if (!company) continue;

      if (aiResult && aiResult[itemId]) {
        const aiSignals = aiResult[itemId].signals;
        if (aiSignals.length > 0) {
          console.log(`  AI signals for news "${news.title.substring(0,50)}...": ${aiSignals.join(', ')}`);
          for (const type of aiSignals) {
            addSignalToCompany(news.company_id, company.company_name, company.website_url,
              type, aiResult[itemId].explanation,
              { label: `News: ${news.title}`, url: news.article_url },
              meta.keywordResults.flatMap(r => r.matchedWords || []));
          }
        }
      } else {
        for (const res of meta.keywordResults) {
          addSignalToCompany(news.company_id, company.company_name, company.website_url,
            res.type, `Keyword match: ${res.matchedWords.join(', ')}`,
            { label: `News: ${news.title}`, url: news.article_url },
            res.matchedWords);
        }
      }
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
    if (!leads || leads.length === 0) continue;

    const description = `Signals detected: ${signalTypes.join(', ')}`;
    const signalDetail = data.explanations.join(' | ') || description;
    const sourceUrls = data.sources;
    const triggeredWords = [...data.triggeredWords];

    for (const lead of leads) {
      if (await hasRecentSignal(lead.id)) continue;

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
        console.log(`  ✅ Signal created for lead ${lead.id}`);
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
