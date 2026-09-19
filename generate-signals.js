const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CHUNK_SIZE = 10;

// ---------- Per-tier daily signal limits ----------
const SIGNAL_LIMITS = {
  free: 1,
  starter: 30,
  growth: 60,
  pro: 200,
};

async function getUserPlan(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();
  return data?.plan || 'free';
}

// ---------- WORD WEIGHTS (feedback only) ----------
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

function normalizeUrl(url) {
  if (!url) return null;
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return 'https://' + trimmed;
}

// ---------- KEYWORD DETECTION (feedback only) ----------
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

// ---------- DAILY CAP COUNT ----------
async function countSignalsToday(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('detected_at', startOfDay.toISOString());
  return count || 0;
}

// ---------- AI CALL ----------
function extractJsonObject(text) {
  if (!text) throw new Error('empty AI response');
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error('no JSON object found');
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
        const waitMs = 20000 * attempt;
        console.warn(`  Rate limited, waiting ${waitMs/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  AI request failed (${response.status}):`, errText);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 12000));
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
        console.warn('  JSON parse failed, retrying...');
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        throw new Error('Could not parse JSON after retries');
      }
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  Retrying (${err.message})...`);
      await new Promise(resolve => setTimeout(resolve, 12000));
    }
  }
  throw new Error('All retries exhausted');
}

async function batchDetectSignals(items) {
  let combinedResult = {};
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const prompt = buildBatchPrompt(chunk);
    console.log(`  Processing chunk ${i/CHUNK_SIZE + 1}...`);
    try {
      const chunkResult = await callOpenRouter(prompt);
      Object.assign(combinedResult, chunkResult);
    } catch (err) {
      console.error('  Chunk failed, skipping.');
    }
  }
  return combinedResult;
}

function buildBatchPrompt(items) {
  let prompt = "You are an assistant that reads web page text and detects business signals a B2B salesperson would care about.\n\n";
  prompt += "Signals: funding, hiring, launch, partnership, expansion, rebranding, leadership, growth.\n";
  prompt += "For each item, return a JSON object with: \"signals\" (array of strings), \"explanation\" (a specific, human sentence describing what actually happened — include names, numbers, and facts when present), and \"confidence\" (0-100).\n";
  prompt += "Be specific. Do not repeat the same idea. If a company appears twice, return the more informative explanation. If the text is just a menu, a historical timeline, an educational article, a job listing, or boilerplate, return empty signals.\n\n";

  for (const item of items) {
    const id = item.id;
    const type = item.type ?? 'page';
    const text = item.text.substring(0, 1500);
    prompt += `ID: ${id}\nType: ${type}\nText:\n${text}\n\n`;
  }

  prompt += "Return a JSON object where each key is an ID, and the value is the object described above. If no signals, use empty array, empty explanation, and confidence 0.\n";
  prompt += "Only return valid JSON. Do not include any other text.";
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
      const aiAgreed = aiSignals.includes(type) || aiSignals.includes('growth');
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
  console.log('Generating signals (per-tier daily limits, no 20-day cap)...');

  await loadWordWeights();

  const { data: latestRun } = await supabase
    .from('scan_runs')
    .select('id')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();
  const scanRunId = latestRun?.id;
  if (!scanRunId) {
    console.log('No scan run found.');
    return;
  }

  const { data: changedPages } = await supabase
    .from('company_pages')
    .select('id, page_url, page_type, company_id')
    .eq('last_status', 'changed')
    .eq('signals_generated', false);

  const { data: newsEntries } = await supabase
    .from('pending_news_signals')
    .select('id, company_id, article_url, title, snippet, pub_date');

  console.log(`Found ${changedPages?.length || 0} changed pages, ${newsEntries?.length || 0} news.`);

  const aiItems = [];
  const itemMeta = {};

  // Process changed pages — skip careers pages from AI text analysis
  if (changedPages) {
    for (const page of changedPages) {
      if (page.page_type === 'careers') {
        const hasHiringSurge = await checkHiringSurge(page.id);
        itemMeta[`page-${page.id}`] = {
          type: 'page',
          page,
          keywordResults: [],
          hasHiringSurge,
          sendToAI: false
        };
        continue;
      }

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

      if (currentText && previousText && currentText !== previousText) {
        const itemId = `page-${page.id}`;
        aiItems.push({ id: itemId, type: 'page', text: currentText });
        itemMeta[itemId] = {
          type: 'page',
          page,
          keywordResults,
          hasHiringSurge: false,
          sendToAI: true,
          sourceUrl: page.page_url
        };
      } else {
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      }
    }
  }

  // Process news
  if (newsEntries) {
    for (const news of newsEntries) {
      const text = `${news.title} ${news.snippet}`;
      const itemId = `news-${news.id}`;
      aiItems.push({ id: itemId, type: 'news', text });
      itemMeta[itemId] = {
        type: 'news',
        news,
        keywordResults: [],
        hasHiringSurge: false,
        sendToAI: true,
        sourceUrl: news.article_url
      };
    }
  }

  let aiResult = {};
  if (aiItems.length > 0) {
    aiResult = await batchDetectSignals(aiItems);
    await applyAIFeedback(itemMeta, aiResult);
  }

  // Batch company lookup
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

  const companySignalsMap = new Map();

  function addSignalToCompany(companyId, companyName, websiteUrl, type, explanation, confidence, sourceUrl, sourceLabel, words) {
    if (!companySignalsMap.has(companyId)) {
      companySignalsMap.set(companyId, {
        companyName,
        websiteUrl,
        signalTypes: new Set(),
        explanations: [],
        sources: [],
        triggeredWords: new Set(),
        confidence: 0
      });
    }
    const entry = companySignalsMap.get(companyId);
    entry.signalTypes.add(type);

    if (explanation && !entry.explanations.includes(explanation)) {
      entry.explanations.push(explanation);
    }

    const normalized = normalizeUrl(sourceUrl);
    if (normalized) {
      const exists = entry.sources.some(s => s.url === normalized);
      if (!exists) {
        entry.sources.push({ label: sourceLabel, url: normalized });
      }
    }

    if (words) words.forEach(w => entry.triggeredWords.add(w));
    if (confidence > entry.confidence) entry.confidence = confidence;
  }

  for (const [itemId, meta] of Object.entries(itemMeta)) {
    const company = companyById.get(meta.type === 'page' ? meta.page.company_id : meta.news.company_id);
    if (!company) continue;

    const aiDecision = aiResult[itemId];
    if (meta.sendToAI && aiDecision && aiDecision.signals && aiDecision.signals.length > 0) {
      console.log(`  AI signals for ${itemId}: ${aiDecision.signals.join(', ')}`);
      const sourceUrl = meta.sourceUrl;
      const sourceLabel = meta.type === 'page'
        ? `${meta.page.page_type}: ${meta.page.page_url}`
        : `News: ${meta.news.title}`;
      for (const type of aiDecision.signals) {
        addSignalToCompany(
          company.id,
          company.company_name,
          company.website_url,
          type,
          aiDecision.explanation,
          aiDecision.confidence || 50,
          sourceUrl,
          sourceLabel,
          meta.keywordResults.flatMap(r => r.matchedWords || [])
        );
      }
    }

    if (meta.type === 'page' && meta.hasHiringSurge) {
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
        90,
        meta.page.page_url,
        'Careers page',
        ['hiring_surge']
      );
    }

    if (meta.type === 'page') {
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', meta.page.id);
    }
  }

  // Create signals per user (grouped, per-tier daily limits, no 20-day cap)
  const createdSignals = new Set();

  for (const [companyId, data] of companySignalsMap.entries()) {
    const signalTypes = [...data.signalTypes];
    if (signalTypes.length === 0) continue;

    const { data: leads } = await supabase
      .from('leads')
      .select('id, user_id')
      .eq('company_name', data.companyName)
      .eq('company_website', data.websiteUrl);
    if (!leads || leads.length === 0) continue;

    const leadsByUser = new Map();
    for (const lead of leads) {
      if (!leadsByUser.has(lead.user_id)) leadsByUser.set(lead.user_id, lead.id);
    }

    const description = `Signals detected: ${signalTypes.join(', ')}`;
    const uniqueExps = [...new Set(data.explanations.map(e => e.trim()).filter(Boolean))];
    const signalDetail = uniqueExps.slice(0, 2).join(' · ') || description;
    const sourceUrls = data.sources;
    const triggeredWords = [...data.triggeredWords];
    const confidence = data.confidence || 50;

    for (const [userId, leadId] of leadsByUser.entries()) {
      // Per-tier daily cap (no 20-day cap anymore)
      const userPlan = await getUserPlan(userId);
      const dailyLimit = SIGNAL_LIMITS[userPlan] ?? 1;

      const todaySignals = await countSignalsToday(userId);
      if (todaySignals >= dailyLimit) {
        console.log(`  Skipping user ${userId} (plan: ${userPlan}, limit: ${dailyLimit}), daily cap reached.`);
        continue;
      }

      const dedupKey = `${userId}-${companyId}`;
      if (createdSignals.has(dedupKey)) continue;
      createdSignals.add(dedupKey);

      const { error: insertError } = await supabase.from('signals').insert({
        lead_id: leadId,
        user_id: userId,
        type: 'multi',
        description,
        signal_detail: signalDetail,
        source_url: data.websiteUrl,
        source_urls: sourceUrls,
        triggered_words: triggeredWords,
        confidence: confidence,
        email_status: 'pending',
        email_subject: `Update: ${data.companyName}`,
        scan_run_id: scanRunId
      });

      if (insertError) {
        console.error(`  Error inserting signal: ${insertError.message}`);
      } else {
        console.log(`  ✅ Signal created for user ${userId} (${data.companyName})`);
      }
    }
  }

  if (newsEntries) {
    const idsToDelete = newsEntries.map(n => n.id);
    await supabase.from('pending_news_signals').delete().in('id', idsToDelete);
  }

  console.log('Signal generation complete.');
}

generateSignals().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
