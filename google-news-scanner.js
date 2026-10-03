const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const parser = new Parser();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const MAX_ARTICLE_AGE_DAYS = 7;
const NEWS_BATCH_SIZE = 5000;
const NEWS_CONCURRENCY = 20;
const DB_PAGE_SIZE = 1000;

// ---------- DISAMBIGUATION ----------
// For companies with short or common names, we require the article to NOT
// contain these disqualifying terms. If it does, we drop the article.
const DISAMBIGUATION_EXCLUDE = {
  'railway': ['station', 'museum', 'metro', 'subway', 'rail yard', 'railyard', 'rail line', 'railway age', 'indian railways', 'network rail', 'rail car', 'railcar', 'freight rail', 'passenger rail', 'train', 'locomotive'],
  'square': ['square feet', 'square foot', 'town square', 'market square', 'times square', 'square meter', 'square mile', 'union square', 'square dance'],
  'circle': ['circle back', 'traffic circle', 'circle of friends', 'full circle', 'arctic circle', 'circle k', 'crop circle'],
  'standard': ['standard deviation', 'industry standard', 'standard time', 'gold standard', 'standard issue', 'standard operating', 'standard oil', 'standard poodle'],
  'compass': ['compass rose', 'moral compass', 'compass point', 'compass direction', 'compass needle'],
  'arena': ['arena concert', 'sports arena', 'arena football', 'arena rock', 'arena tour'],
  'just': ['just announced', 'just said', 'just in', 'just now', 'just a', 'just the', 'just one'],
  'progress': ['progress report', 'in progress', 'make progress', 'progress bar', 'progress made', 'making progress'],
  'felix': ['felix the cat', 'felix mendelssohn', 'felix salten', 'hurricane felix'],
  'standard bank': ['standard bank of south africa', 'standard chartered'],
  'relay': ['relay race', 'relay for life', 'torch relay', 'relay baton', 'relay station'],
  'ladder': ['corporate ladder', 'social ladder', 'ladder tournament', 'fire ladder'],
  'arena group': [],
  'circle ci': [],
  'nation': ['nation state', 'nation building', 'nation wide', 'nationwide'],
  'comcast': [],
  'orbit': ['orbit the earth', 'earth orbit', 'lunar orbit', 'orbital'],
  'column': ['newspaper column', 'column inch', 'spinal column', 'column graph'],
  'hex': ['hex code', 'hex color', 'hex nut', 'hex key'],
  'arc': ['arc of', 'story arc', 'arc welding', 'arc reactor'],
  'nova': ['nova scotia', 'nova pbs', 'supernova', 'nova star'],
  'delta': ['delta airlines', 'delta variant', 'mississippi delta', 'river delta'],
  'unity': ['unity in', 'community unity', 'unity of', 'unity government'],
  'prism': ['prism light', 'prism optics', 'prism effect'],
  'venture': ['venture capital', 'venture fund', 'joint venture'],
  'venture capital': [],
  'axial': [],
};

function isDisqualified(companyName, articleText) {
  const lower = companyName.toLowerCase().trim();
  const excludes = DISAMBIGUATION_EXCLUDE[lower];
  if (!excludes || excludes.length === 0) return false;
  const text = articleText.toLowerCase();
  return excludes.some(term => text.includes(term));
}

// ---------- HELPERS ----------
function isArticleRecent(pubDate) {
  if (!pubDate) return true;
  const articleDate = new Date(pubDate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_ARTICLE_AGE_DAYS);
  return articleDate >= cutoff;
}

async function getProcessedUrls(companyId) {
  const { data } = await supabase
    .from('news_articles')
    .select('article_url')
    .eq('company_id', companyId);
  return new Set((data || []).map(row => row.article_url));
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
    return;
  }

  if (!feed.items || feed.items.length === 0) return;

  const processedUrls = await getProcessedUrls(company.id);
  let newArticles = 0;

  for (const item of feed.items) {
    const link = item.link;
    if (!link) continue;
    if (processedUrls.has(link)) continue;
    if (!isArticleRecent(item.pubDate)) continue;

    const title = item.title || '';
    const snippet = item.contentSnippet || item.content || '';

    const combinedText = `${title} ${snippet}`.toLowerCase();
    const companyNameLower = company.company_name.toLowerCase();
    const escaped = companyNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (!namePattern.test(combinedText)) {
      await markArticleProcessed(company.id, link, title, item.pubDate);
      continue;
    }

    // Disambiguation check for generic company names
    if (isDisqualified(company.company_name, combinedText)) {
      console.log(`    Disqualified (generic name match): ${title}`);
      await markArticleProcessed(company.id, link, title, item.pubDate);
      continue;
    }

    const { error: insertErr } = await supabase.from('pending_news_signals').insert({
      company_id: company.id,
      article_url: link,
      title,
      snippet,
      pub_date: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    });

    if (insertErr) {
      console.error(`    Failed to insert article: ${insertErr.message}`);
    } else {
      newArticles++;
    }

    await markArticleProcessed(company.id, link, title, item.pubDate);
  }

  if (newArticles > 0) {
    console.log(`  ${company.company_name}: ${newArticles} new articles`);
  }
}

async function concurrentMap(items, limit, asyncFn) {
  let index = 0;
  const results = new Array(items.length);
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await asyncFn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

async function fetchCompaniesBatch(limit) {
  const rows = [];
  for (let from = 0; from < limit; from += DB_PAGE_SIZE) {
    const to = Math.min(from + DB_PAGE_SIZE, limit) - 1;
    const { data, error } = await supabase
      .from('companies')
      .select('id, company_name, website_url')
      .not('website_url', 'is', null)
      .order('last_scanned_at', { ascending: true, nullsFirst: true })
      .range(from, to);
    if (error) {
      console.error('Company fetch failed:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < DB_PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  console.log(`Collecting Google News (batch: ${NEWS_BATCH_SIZE}, concurrency: ${NEWS_CONCURRENCY})...`);

  const companies = await fetchCompaniesBatch(NEWS_BATCH_SIZE);

  if (!companies || companies.length === 0) {
    console.log('No companies to scan.');
    return;
  }

  console.log(`Scanning news for ${companies.length} companies...`);

  let done = 0;
  await concurrentMap(companies, NEWS_CONCURRENCY, async (company) => {
    try {
      await scanCompanyNews(company);
    } catch (e) {
      console.error(`  Error processing ${company.company_name}: ${e.message}`);
    } finally {
      done++;
      if (done % 100 === 0) console.log(`  Progress: ${done}/${companies.length}`);
    }
  });

  console.log('\nGoogle News collection complete.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
