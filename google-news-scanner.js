const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const parser = new Parser();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const MAX_ARTICLE_AGE_DAYS = 7;
const NEWS_BATCH_SIZE = 1000;
const NEWS_CONCURRENCY = 5;
const DB_PAGE_SIZE = 1000;

function isArticleRecent(pubDate) {
  if (!pubDate) return true;
  const articleDate = new Date(pubDate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_ARTICLE_AGE_DAYS);
  return articleDate >= cutoff;
}

async function getProcessedUrls(companyId) {
  const { data } = await supabase.from('news_articles').select('article_url').eq('company_id', companyId);
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

  await new Promise(r => setTimeout(r, Math.random() * 3000 + 2000));

  let feed;
  try {
    feed = await parser.parseURL(rssUrl);
  } catch (err) {
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

    const { error: insertErr } = await supabase.from('pending_news_signals').insert({
      company_id: company.id,
      article_url: link,
      title,
      snippet,
      pub_date: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    });

    if (!insertErr) newArticles++;
    await markArticleProcessed(company.id, link, title, item.pubDate);
  }

  if (newArticles > 0) console.log(`  ${company.company_name}: ${newArticles} new articles`);
}

async function concurrentMap(items, limit, asyncFn) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      await asyncFn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
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
    if (error || !data || data.length === 0) break;
    rows.push(...data);
    if (data.length < DB_PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  console.log(`Collecting Google News (batch: ${NEWS_BATCH_SIZE}, concurrency: ${NEWS_CONCURRENCY})...`);
  const companies = await fetchCompaniesBatch(NEWS_BATCH_SIZE);
  if (!companies || companies.length === 0) return;

  await concurrentMap(companies, NEWS_CONCURRENCY, async (company) => {
    try { await scanCompanyNews(company); } catch (e) {}
  });
  console.log('\nGoogle News collection complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
