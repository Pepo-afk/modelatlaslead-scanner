const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const parser = new Parser();

// REAL-TIME DISABLED – prevents process from hanging
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
    realtime: { enabled: false }        // <--- ADD THIS LINE
  }
);

const MAX_ARTICLE_AGE_DAYS = 7;
const MAX_ARTICLES_TO_CHECK = 50;

const KEYWORDS = {
  funding: ['raised', 'funding', 'series a', 'series b', 'series c', 'investment', 'backed by', 'million', 'billion', 'seed round'],
  hiring: ['hiring', 'join us', "we're growing", 'new team', 'expanding team', 'careers', 'open positions', 'now hiring'],
  launch: ['launch', 'announcing', 'introducing', 'new product', 'now available', 'released'],
  partnership: ['partnership', 'partner with', 'integrates with', 'collaboration', 'alliance'],
  expansion: ['new office', 'expanding to', 'now in ', 'new location', 'global expansion'],
  rebranding: ['rebrand', 'new look', 'new name', 'new logo', 'refresh'],
  leadership: ['new ceo', 'new cto', 'new cfo', 'appointed', 'hired as', 'takes over as', 'promoted to'],
};

function detectSignalTypes(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const [type, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => lower.includes(w))) {
      found.push(type);
    }
  }
  return [...new Set(found)];
}

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

async function getProcessedUrls(companyId) {
  const { data } = await supabase
    .from('news_articles')
    .select('article_url')
    .eq('company_id', companyId);
  return new Set((data || []).map(row => row.article_url));
}

function isArticleRecent(pubDate) {
  if (!pubDate) return true;
  const articleDate = new Date(pubDate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_ARTICLE_AGE_DAYS);
  return articleDate >= cutoff;
}

async function markArticleProcessed(companyId, articleUrl, title, pubDate) {
  await supabase.from('news_articles').insert({
    company_id: companyId,
    article_url: articleUrl,
    title,
    pub_date: pubDate ? new Date(pubDate).toISOString() : null,
  }).select('id').maybeSingle();
}

async function scanCompanyNews(company) {
  const name = company.company_name;
  const query = encodeURIComponent(`"${name}" (funding OR hiring OR launch OR partnership OR expansion OR rebranding OR leadership)`);
  const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en&gl=US&ceid=US:en`;

  let feed;
  try {
    feed = await parser.parseURL(rssUrl);
  } catch (err) {
    console.log(`  Failed to fetch RSS for ${name}: ${err.message}`);
    return new Set();
  }

  if (!feed.items || feed.items.length === 0) {
    console.log(`  No news articles for ${name}`);
    return new Set();
  }

  const processedUrls = await getProcessedUrls(company.id);
  console.log(`  ${processedUrls.size} already processed, checking up to ${Math.min(feed.items.length, MAX_ARTICLES_TO_CHECK)}…`);

  const signalTypes = new Set();
  let checkedCount = 0;

  for (const item of feed.items) {
    if (checkedCount >= MAX_ARTICLES_TO_CHECK) break;
    const link = item.link;
    if (!link) continue;
    checkedCount++;

    if (processedUrls.has(link)) continue;
    if (!isArticleRecent(item.pubDate)) continue;

    const title = item.title || '';
    const snippet = item.contentSnippet || item.content || '';
    const text = `${title} ${snippet}`;
    const types = detectSignalTypes(text);

    if (types.length > 0) {
      console.log(`    Signals: ${types.join(', ')} → ${link}`);
      types.forEach(t => signalTypes.add(t));
    }

    await markArticleProcessed(company.id, link, title, item.pubDate);
  }

  return signalTypes;
}

async function processCompany(company) {
  const signalTypes = await scanCompanyNews(company);
  if (signalTypes.size === 0) return;

  const { data: leads } = await supabase
    .from('leads')
    .select('id, user_id')
    .eq('company_name', company.company_name)
    .eq('company_website', company.website_url);

  if (!leads || leads.length === 0) {
    console.log(`  No leads for ${company.company_name}, skipping.`);
    return;
  }

  const description = `News: ${[...signalTypes].join(', ')}`;
  const subject = `News about ${company.company_name}`;

  for (const lead of leads) {
    if (await hasRecentSignal(lead.id)) {
      console.log(`  Skipping lead ${lead.id} (20-day cap)`);
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
      console.log(`  Duplicate news signal for lead ${lead.id} today, skipping.`);
      continue;
    }

    const { error: insertErr } = await supabase.from('signals').insert({
      lead_id: lead.id,
      user_id: lead.user_id,
      type: 'news',
      description,
      source_url: company.website_url,
      email_status: 'pending',
      email_subject: subject,
    });

    if (insertErr) {
      console.error(`  Error inserting signal: ${insertErr.message}`);
    } else {
      console.log(`  Created news signal for lead ${lead.id}`);
    }
  }
}

async function main() {
  console.log('Starting Google News scan (optimised)…');

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, company_name, website_url')
    .not('website_url', 'is', null);

  if (error || !companies?.length) {
    console.log('No companies to scan.');
    return;
  }

  for (const company of companies) {
    console.log(`\nScanning news for ${company.company_name}…`);
    try {
      await processCompany(company);
    } catch (e) {
      console.error(`  Error processing ${company.company_name}: ${e.message}`);
    }
  }

  console.log('\nGoogle News scan complete.');
  process.exit(0);   // <-- ensure clean exit
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}); 
