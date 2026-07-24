const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const parser = new Parser();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const MAX_ARTICLE_AGE_DAYS = 7;

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

  if (!feed.items || feed.items.length === 0) {
    console.log(`  No news articles for ${name}`);
    return;
  }

  const processedUrls = await getProcessedUrls(company.id);
  let newArticles = 0;

  for (const item of feed.items) {
    const link = item.link;
    if (!link) continue;
    if (processedUrls.has(link)) continue;
    if (!isArticleRecent(item.pubDate)) continue;

    const title = item.title || '';
    const snippet = item.contentSnippet || item.content || '';

    // Relevance filter – company name as whole word + business context
    const combinedText = `${title} ${snippet}`.toLowerCase();
    const companyNameLower = company.company_name.toLowerCase();
    const namePattern = new RegExp(`\\b${companyNameLower}\\b`, 'i');
    if (!namePattern.test(combinedText)) {
      console.log(`    Irrelevant (name not found): ${title}`);
      await markArticleProcessed(company.id, link, title, item.pubDate);
      continue;
    }
    const businessWords = ['startup', 'company', 'platform', 'raises', 'funding', 'saas', 'tech', 'software', 'firm', 'venture'];
    const hasBusinessContext = businessWords.some(w => combinedText.includes(w));
    if (!hasBusinessContext) {
      console.log(`    Irrelevant (no business context): ${title}`);
      await markArticleProcessed(company.id, link, title, item.pubDate);
      continue;
    }

    // Store article for later processing by the signal generator
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

  console.log(`  ${newArticles} new relevant articles stored.`);
}

async function main() {
  console.log('Collecting Google News articles (no signal creation)...');

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
      await scanCompanyNews(company);
    } catch (e) {
      console.error(`  Error processing ${company.company_name}: ${e.message}`);
    }
  }

  console.log('\nGoogle News collection complete.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
