const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CHUNK_SIZE = 10;   // items per AI request

// ---------- WORD-LEVEL LEARNING DATA (still used to train, but not for detection) ----------
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
  console.log(`Loaded ${wordWeights.size} word weights (for feedback only).`);
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

// ---------- KEYWORD DETECTION FUNCTIONS (now only for training feedback, not signal decision) ----------
// All detection functions are kept but not used to decide signals.
// They are still used to collect matchedWords for AI feedback learning.
async function detectFunding(text) {
  // same as before
  // returns { triggered, score, threshold, matchedWords }
}
async function detectHiringSurgeText(text) { /* same as before */ }
async function detectProductLaunch(text) { /* same */ }
async function detectPartnership(text) { /* same */ }
async function detectExpansion(text) { /* same */ }
async function detectRebranding(text) { /* same */ }
async function detectLeadershipChange(text) { /* same */ }

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

// ---------- AI CALL WITH ROBUST JSON PARSING AND RETRIES ----------
function extractJsonObject(text) {
  if (!text) throw new Error('empty AI response');
  let cleaned = text.trim();
  // Remove markdown code fences if any
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('no JSON object found');
  }
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

async function callOpenRouter(prompt, retries = 5) {
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
        const waitMs = 15000 * attempt;
        console.warn(`  Rate limited, retrying in ${waitMs/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  AI request failed (${response.status}):`, errText);
        if (attempt < retries) {
          console.warn(`  Retrying attempt ${attempt+1}...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        throw new Error(`OpenRouter API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('no content in AI response');

      try {
        return extractJsonObject(content);
      } catch (parseErr) {
        console.warn(`  JSON parse failed (${parseErr.message}), retrying...`);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 8000));
          continue;
        }
        throw new Error('Could not parse JSON after retries');
      }
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  Request failed: ${err.message}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  throw new Error('All retries exhausted');
}

async function batchDetectSignals(items) {
  let combinedResult = {};
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const prompt = buildBatchPrompt(chunk);
    console.log(`  Processing chunk ${i/CHUNK_SIZE + 1} with ${chunk.length} items...`);
    try {
      const chunkResult = await callOpenRouter(prompt);
      Object.assign(combinedResult, chunkResult);
    } catch (err) {
      console.error(`  Chunk ${i/CHUNK_SIZE + 1} failed permanently:`, err.message);
      // We do NOT fallback to keyword engine. Just skip this chunk.
      // You may want to mark these items as processed to avoid infinite loop, but for now skip.
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
  prompt += "Only return valid JSON. Do not include any other text, comments, or markdown.";
  return prompt;
}

// ---------- AI FEEDBACK LEARNING (still trains word weights from AI decisions) ----------
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
  console.log('Generating signals (AI only, robust retry)...');

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

  // Process pages: gather only changed pages with at least one snapshot and keyword match?
  // We will now send EVERY changed page to AI, but only those with at least 2 snapshots to compare.
  // The AI will decide if signal exists. We'll still collect keyword matchedWords for feedback.
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

      // Collect keyword results for feedback later
      const keywordResults = await getSignalsFromTextKeyword(currentText, previousText);

      // Hiring surge (numeric) still applied directly; we don't need AI for that.
      let hasHiringSurge = false;
      if (page.page_type === 'careers') {
        hasHiringSurge = await checkHiringSurge(page.id);
      }

      // Always add to AI batch if there is actual text change (even if no keyword results), so AI can decide
      if (currentText && previousText && currentText !== previousText) {
        const itemId = `page-${page.id}`;
        aiItems.push({ id: itemId, type: 'page', text: currentText });
        itemMeta[itemId] = { type: 'page', page, keywordResults, hasHiringSurge };
      } else {
        // If no change, mark as processed to avoid future loops
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      }
    }
  }

  // Process news
  if (newsEntries && newsEntries.length > 0) {
    for (const news of newsEntries) {
      const text = `${news.title} ${news.snippet}`;
      // We'll include all news for AI; no keyword prefilter.
      const itemId = `news-${news.id}`;
      aiItems.push({ id: itemId, type: 'news', text });
      itemMeta[itemId] = { type: 'news', news, keywordResults: [] };
    }
  }

  // Batch AI call (no fallback)
  let aiResult = {};
  if (aiItems.length > 0) {
    aiResult = await batchDetectSignals(aiItems);
    if (Object.keys(aiResult).length === 0) {
      console.warn('AI returned no results for any item. Continuing with possible hiring surges only.');
    } else {
      await applyAIFeedback(itemMeta, aiResult);
    }
  }

  // Now process results and create signals
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

  // First, add hiring surges from itemMeta (even if AI didn't respond)
  for (const [itemId, meta] of Object.entries(itemMeta)) {
    if (meta.type === 'page' && meta.hasHiringSurge) {
      const page = meta.page;
      const companyId = page.company_id;
      // Fetch company data (batched later)
      // We'll handle company data in the loop below instead.
    }
  }

  // Batch fetch company data for all unique company_ids
  const companyIds = new Set();
  for (const meta of Object.values(itemMeta)) {
    if (meta.type === 'page') companyIds.add(meta.page.company_id);
    else if (meta.type === 'news') companyIds.add(meta.news.company_id);
  }
  const companyById = new Map();
  if (companyIds.size > 0) {
    const { data: companiesData } = await supabase
      .from('companies')
      .select('id, company_name, website_url')
      .in('id', Array.from(companyIds));
    for (const c of companiesData || []) companyById.set(c.id, c);
  }

  // Process each item: either from AI result or hiring surge
  for (const [itemId, meta] of Object.entries(itemMeta)) {
    const company = companyById.get(meta.type === 'page' ? meta.page.company_id : meta.news.company_id);
    if (!company) continue;

    // Check AI result for this item
    const aiDecision = aiResult[itemId];
    if (aiDecision && aiDecision.signals && aiDecision.signals.length > 0) {
      console.log(`  AI signals for ${itemId}: ${aiDecision.signals.join(', ')}`);
      for (const type of aiDecision.signals) {
        addSignalToCompany(
          company.id,
          company.company_name,
          company.website_url,
          type,
          aiDecision.explanation,
          { label: `${meta.type === 'page' ? meta.page.page_type + ': ' + meta.page.page_url : 'News: ' + meta.news.title}`, url: meta.type === 'page' ? meta.page.page_url : meta.news.article_url },
          meta.keywordResults.flatMap(r => r.matchedWords || [])
        );
      }
    }

    // Add hiring surge if present and no AI signal for hiring (avoid duplicates)
    if (meta.type === 'page' && meta.hasHiringSurge) {
      if (!aiDecision || !aiDecision.signals.includes('hiring')) {
        const { data: snapJob } = await supabase
          .from('page_snapshots')
          .select('job_count')
          .eq('company_page_id', meta.page.id)
          .order('fetched_at', { ascending: false })
          .limit(2);
        const now = snapJob?.[0]?.job_count || 0;
        const before = snapJob?.[1]?.job_count || 0;
        addSignalToCompany(
          company.id,
          company.company_name,
          company.website_url,
          'hiring',
          `Job openings increased from ${before} to ${now}.`,
          { label: 'Careers page', url: meta.page.page_url },
          ['hiring_surge']
        );
      }
    }

    // Mark page as processed if it was a page
    if (meta.type === 'page') {
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', meta.page.id);
    }
  }

  // Create grouped signals for each company
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
