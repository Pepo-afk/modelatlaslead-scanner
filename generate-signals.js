const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CHUNK_SIZE = 5;

const SIGNAL_LIMITS = { free: 1, starter: 30, growth: 60, pro: 200 };

async function getUserPlan(userId) {
  const { data } = await supabase.from('profiles').select('plan').eq('id', userId).maybeSingle();
  return data?.plan || 'free';
}

let wordWeights = new Map();
async function loadWordWeights() {
  const { data } = await supabase.from('word_feedback').select('word, good, bad, ai_good, ai_bad');
  wordWeights.clear();
  for (const row of data || []) {
    const totalUser = row.good + row.bad;
    const weightedTotal = (totalUser * 3) + ((row.ai_good || 0) + (row.ai_bad || 0));
    if (weightedTotal === 0) continue;
    const ratio = ((row.good * 3) + (row.ai_good || 0)) / weightedTotal;
    wordWeights.set(row.word, ratio < 0.3 ? 0.1 : ratio < 0.5 ? 0.5 : 1.0);
  }
  console.log(`Loaded ${wordWeights.size} word weights.`);
}
function getWordWeight(word) { return wordWeights.get(word) ?? 1.0; }

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('http') ? trimmed : 'https://' + trimmed;
}

// ---------- KEYWORD DETECTORS ----------
async function detectFunding(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: 'raises', points: 2 }, { phrase: 'raised', points: 2 }, { phrase: 'secures', points: 2 }, { phrase: 'closed', points: 2 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points * getWordWeight(kw.phrase); matched.push(kw.phrase); } }
  if (/\$\d+[mMkKbB]?|\d+\s?(million|billion)/i.test(lower)) { score += 3; matched.push('AMOUNT_PATTERN'); }
  return { triggered: score >= 5, score, threshold: 5, matchedWords: matched };
}
async function detectHiringSurgeText(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: "we're hiring", points: 3 }, { phrase: 'now hiring', points: 3 }, { phrase: 'expanding our team', points: 3 }, { phrase: 'multiple openings', points: 3 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points; matched.push(kw.phrase); } }
  return { triggered: score >= 3, score, threshold: 3, matchedWords: matched };
}
async function detectProductLaunch(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: 'introducing', points: 2 }, { phrase: 'launch', points: 2 }, { phrase: 'launched', points: 2 }, { phrase: 'now available', points: 2 }, { phrase: 'new product', points: 3 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points; matched.push(kw.phrase); } }
  return { triggered: score >= 5, score, threshold: 5, matchedWords: matched };
}
async function detectPartnership(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: 'partnership', points: 2 }, { phrase: 'partners with', points: 2 }, { phrase: 'integrates with', points: 2 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points; matched.push(kw.phrase); } }
  return { triggered: score >= 3, score, threshold: 3, matchedWords: matched };
}
async function detectExpansion(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: 'new office', points: 2 }, { phrase: 'expanding to', points: 2 }, { phrase: 'global expansion', points: 2 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points; matched.push(kw.phrase); } }
  return { triggered: score >= 4, score, threshold: 4, matchedWords: matched };
}
async function detectRebranding(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: 'rebrand', points: 2 }, { phrase: 'new name', points: 2 }, { phrase: 'formerly known as', points: 3 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points; matched.push(kw.phrase); } }
  return { triggered: score >= 4, score, threshold: 4, matchedWords: matched };
}
async function detectLeadershipChange(text) {
  const lower = text.toLowerCase();
  const keywords = [{ phrase: 'new ceo', points: 3 }, { phrase: 'new cto', points: 3 }, { phrase: 'appointed', points: 3 }, { phrase: 'hired as', points: 3 }];
  let score = 0; const matched = [];
  for (const kw of keywords) { if (lower.includes(kw.phrase)) { score += kw.points; matched.push(kw.phrase); } }
  return { triggered: score >= 5, score, threshold: 5, matchedWords: matched };
}

async function getSignalsFromTextKeyword(text) {
  if (!text || text.length < 30) return [];
  const detectors = [
    { type: 'funding', fn: detectFunding }, { type: 'hiring', fn: detectHiringSurgeText },
    { type: 'launch', fn: detectProductLaunch }, { type: 'partnership', fn: detectPartnership },
    { type: 'expansion', fn: detectExpansion }, { type: 'rebranding', fn: detectRebranding },
    { type: 'leadership', fn: detectLeadershipChange },
  ];
  const results = [];
  for (const { type, fn } of detectors) {
    const res = await fn(text);
    if (res.triggered) results.push({ type, score: res.score, threshold: res.threshold, matchedWords: res.matchedWords });
  }
  return results;
}

async function checkHiringSurge(pageId) {
  const { data: snapshots } = await supabase.from('page_snapshots').select('job_count').eq('company_page_id', pageId).order('fetched_at', { ascending: false }).limit(2);
  if (!snapshots || snapshots.length < 2) return false;
  return (snapshots[1].job_count !== null && snapshots[0].job_count !== null && (snapshots[0].job_count - snapshots[1].job_count) >= 5);
}

async function countSignalsToday(userId) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const { count } = await supabase.from('signals').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('detected_at', startOfDay.toISOString());
  return count || 0;
}

// ---------- JSON / AI ----------
function extractJsonObject(text) {
  if (!text) throw new Error('empty');
  let cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error('no JSON object found');
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

async function callOpenRouter(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 15000 * attempt));
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error(`  HTTP ${response.status}:`, errText.slice(0, 150));
      if (attempt < retries) { await new Promise(r => setTimeout(r, 5000)); continue; }
      throw new Error(`OpenRouter ${response.status}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason;
    const content = message?.content;

    // Non-retryable: content filter or provider error
    if (finishReason === 'content_filter') {
      console.warn('  Skipping (content_filter)');
      return {};
    }
    if (choice?.error) {
      console.warn(`  Skipping (provider error: ${choice.error.code || 'unknown'})`);
      return {};
    }

    // Try content first
    if (content) {
      try {
        return extractJsonObject(content);
      } catch (e) {
        // Content exists but is not JSON. If it is short and contains no braces, it is a refusal. Skip.
        if (content.length < 80 && !content.includes('{')) {
          console.warn(`  Skipping (non-JSON content: "${content.slice(0, 40)}")`);
          return {};
        }
        // Otherwise, fall through to reasoning fallback
      }
    }

    // Fallback: check reasoning field for valid JSON
    if (message?.reasoning) {
      try {
        const parsed = extractJsonObject(message.reasoning);
        console.log('  Recovered from reasoning field');
        return parsed;
      } catch (e) {
        // reasoning was just thinking text, not JSON
      }
    }

    // No usable content. Retry.
    if (attempt < retries) {
      console.warn('  Retrying (no usable content)');
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    throw new Error('no usable content after retries');
  }
  throw new Error('All retries exhausted');
}

function buildBatchPrompt(items) {
  let prompt = "Detect business signals. Return JSON only. No thinking, no explanation.\n\n";
  prompt += "Valid signals: funding, hiring, launch, partnership, expansion, rebranding, leadership, growth.\n";
  prompt += "Rules:\n";
  prompt += "- Only specific new events with a date or clear recent timing.\n";
  prompt += "- Ignore company descriptions, about pages, press-kit copy, menus, job listings, boilerplate.\n";
  prompt += "- Ignore 'X powers Y businesses', 'X has Z integrations', founding years, team size, awards.\n";
  prompt += "- If no signal, return empty array for that ID.\n\n";
  prompt += "Output format (JSON only, no other text):\n";
  prompt += "{\"ID\": {\"signals\": [], \"explanation\": \"\", \"confidence\": 0, \"source_url\": null}}\n\n";
  prompt += "Items to analyze:\n\n";

  for (const item of items) {
    prompt += `ID: ${item.id}\nType: ${item.type}\n`;
    if (item.articleLinks?.length) {
      prompt += `Links:\n`;
      for (const link of item.articleLinks.slice(0, 5)) {
        prompt += `- ${String(link.title).slice(0, 80)} => ${link.url}\n`;
      }
    }
    prompt += `Text: ${item.text.substring(0, 800)}\n\n`;
  }
  prompt += "Return ONLY the JSON object. No markdown, no explanation, no preamble.";
  return prompt;
}

async function batchDetectSignals(items) {
  let combinedResult = {};
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(items.length / CHUNK_SIZE);
    console.log(`  Chunk ${chunkNum}/${totalChunks}`);
    try {
      const chunkResult = await callOpenRouter(buildBatchPrompt(chunk));
      Object.assign(combinedResult, chunkResult);
    } catch (err) {
      console.error(`  Chunk ${chunkNum} failed: ${err.message}`);
    }
  }
  return combinedResult;
}

// ---------- MAIN ----------
async function generateSignals() {
  console.log('Generating signals...');
  await loadWordWeights();

  const { data: latestRun } = await supabase.from('scan_runs').select('id').order('started_at', { ascending: false }).limit(1).single();
  if (!latestRun) { console.log('No scan run found.'); return; }

  const { data: changedPages } = await supabase
    .from('company_pages')
    .select('id, page_url, page_type, company_id')
    .eq('last_status', 'changed')
    .eq('signals_generated', false)
    .limit(200);

  const { data: newsEntries } = await supabase
    .from('pending_news_signals')
    .select('id, company_id, article_url, title, snippet')
    .limit(200);

  console.log(`Found ${changedPages?.length || 0} changed pages, ${newsEntries?.length || 0} news.`);

  const aiItems = [];
  const itemMeta = {};

  if (changedPages) {
    for (const page of changedPages) {
      if (page.page_type === 'careers') {
        const hasHiringSurge = await checkHiringSurge(page.id);
        itemMeta[`page-${page.id}`] = { type: 'page', page, keywordResults: [], hasHiringSurge, sendToAI: false };
        continue;
      }

      const { data: snap } = await supabase
        .from('page_snapshots')
        .select('cleaned_text, article_links')
        .eq('company_page_id', page.id)
        .order('fetched_at', { ascending: false })
        .limit(2);

      if (!snap || snap.length < 2) {
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
        continue;
      }

      const currentText = snap[0].cleaned_text || '';
      const previousText = snap[1].cleaned_text || '';
      const articleLinks = Array.isArray(snap[0].article_links) ? snap[0].article_links : null;
      const keywordResults = await getSignalsFromTextKeyword(currentText);

      if (currentText && previousText && currentText !== previousText) {
        const itemId = `page-${page.id}`;
        aiItems.push({ id: itemId, type: 'page', text: currentText, articleLinks });
        itemMeta[itemId] = {
          type: 'page', page, keywordResults, hasHiringSurge: false,
          sendToAI: true, sourceUrl: page.page_url, articleLinks
        };
      } else {
        await supabase.from('company_pages').update({ signals_generated: true }).eq('id', page.id);
      }
    }
  }

  if (newsEntries) {
    for (const news of newsEntries) {
      const itemId = `news-${news.id}`;
      aiItems.push({ id: itemId, type: 'news', text: `${news.title} ${news.snippet}` });
      itemMeta[itemId] = { type: 'news', news, keywordResults: [], hasHiringSurge: false, sendToAI: true, sourceUrl: news.article_url };
    }
  }

  let aiResult = {};
  if (aiItems.length > 0) {
    console.log(`Sending ${aiItems.length} items in ${Math.ceil(aiItems.length / CHUNK_SIZE)} chunks...`);
    aiResult = await batchDetectSignals(aiItems);
  }

  const companyIds = new Set();
  for (const meta of Object.values(itemMeta)) {
    if (meta.type === 'page') companyIds.add(meta.page.company_id);
    else if (meta.type === 'news') companyIds.add(meta.news.company_id);
  }

  const companyById = new Map();
  if (companyIds.size > 0) {
    const ids = Array.from(companyIds);
    for (let i = 0; i < ids.length; i += 1000) {
      const slice = ids.slice(i, i + 1000);
      const { data: companiesData } = await supabase
        .from('companies')
        .select('id, company_name, website_url, is_featured')
        .in('id', slice);
      for (const c of companiesData || []) companyById.set(c.id, c);
    }
  }

  const companySignalsMap = new Map();

  for (const [itemId, meta] of Object.entries(itemMeta)) {
    const companyId = meta.type === 'page' ? meta.page.company_id : meta.news.company_id;
    const company = companyById.get(companyId);
    if (!company) continue;

    const aiDecision = aiResult[itemId];
    if (meta.sendToAI && aiDecision?.signals?.length > 0) {
      if (!companySignalsMap.has(companyId)) {
        companySignalsMap.set(companyId, {
          companyName: company.company_name,
          websiteUrl: company.website_url,
          isFeatured: company.is_featured === true,
          signalTypes: new Set(),
          explanations: [],
          sources: [],
          confidence: 0
        });
      }
      const entry = companySignalsMap.get(companyId);
      for (const t of aiDecision.signals) entry.signalTypes.add(t);
      if (aiDecision.explanation && !entry.explanations.includes(aiDecision.explanation)) entry.explanations.push(aiDecision.explanation);
      const normalized = normalizeUrl(meta.sourceUrl);
      if (normalized && !entry.sources.some(s => s.url === normalized)) {
        entry.sources.push({
          label: meta.type === 'page' ? `${meta.page.page_type}: ${meta.page.page_url}` : `News: ${meta.news.title}`,
          url: normalized
        });
      }
      if (aiDecision.confidence > entry.confidence) entry.confidence = aiDecision.confidence;
    }

    if (meta.type === 'page' && meta.hasHiringSurge) {
      if (!companySignalsMap.has(companyId)) {
        companySignalsMap.set(companyId, {
          companyName: company.company_name,
          websiteUrl: company.website_url,
          isFeatured: company.is_featured === true,
          signalTypes: new Set(),
          explanations: [],
          sources: [],
          confidence: 90
        });
      }
      const entry = companySignalsMap.get(companyId);
      entry.signalTypes.add('hiring');
      entry.explanations.push('Job openings increased by 5 or more.');
      entry.confidence = 90;
    }

    if (meta.type === 'page') {
      await supabase.from('company_pages').update({ signals_generated: true }).eq('id', meta.page.id);
    }
  }

  // Create signals. company is now available via data.isFeatured and data.companyName.
  for (const [companyId, data] of companySignalsMap.entries()) {
    const signalTypes = [...data.signalTypes];
    if (signalTypes.length === 0) continue;

    const description = `Signals detected: ${signalTypes.join(', ')}`;
    const detail = data.explanations[0] || description;
    const signalDetail = detail.length > 180 ? detail.slice(0, 177) + '...' : detail;
    const confidence = data.confidence || 50;

    if (data.isFeatured) {
      const { error } = await supabase.from('signals').insert({
        lead_id: null,
        user_id: null,
        type: 'multi',
        description,
        signal_detail: signalDetail,
        source_url: data.websiteUrl,
        source_urls: data.sources,
        confidence,
        email_status: 'no_email',
        email_subject: `Update: ${data.companyName}`,
        scan_run_id: latestRun.id,
        is_hidden: false
      });
      if (!error) console.log(`  Featured: ${data.companyName}`);
      else console.error(`  Error inserting featured signal: ${error.message}`);
    }

    const { data: leads } = await supabase
      .from('leads')
      .select('id, user_id')
      .eq('company_name', data.companyName)
      .eq('company_website', data.websiteUrl);

    if (leads?.length > 0) {
      const leadsByUser = new Map();
      for (const lead of leads) if (!leadsByUser.has(lead.user_id)) leadsByUser.set(lead.user_id, lead.id);

      for (const [userId, leadId] of leadsByUser.entries()) {
        const userPlan = await getUserPlan(userId);
        const dailyLimit = SIGNAL_LIMITS[userPlan] ?? 1;
        const todaySignals = await countSignalsToday(userId);
        if (todaySignals >= dailyLimit) continue;

        await supabase.from('signals').insert({
          lead_id: leadId,
          user_id: userId,
          type: 'multi',
          description,
          signal_detail: signalDetail,
          source_url: data.websiteUrl,
          source_urls: data.sources,
          confidence,
          email_status: 'pending',
          email_subject: `Update: ${data.companyName}`,
          scan_run_id: latestRun.id
        });
      }
    }
  }

  if (newsEntries?.length) {
    await supabase.from('pending_news_signals').delete().in('id', newsEntries.map(n => n.id));
  }

  console.log('Signal generation complete.');
}

generateSignals().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 
