const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const pLimit = require('p-limit');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const MAX_PAGES_PER_COMPANY = 8;
const MAX_CONCURRENT_PAGES = 5;
const FETCH_TIMEOUT_MS = 8000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_TYPE_KEYWORDS = {
  blog: ['blog', 'news', 'articles', 'stories'],
  careers: ['careers', 'jobs', 'work', 'team'],
  press: ['press', 'media', 'newsroom'],
  about: ['about', 'company', 'team'],
};

const URL_BLACKLIST = [
  'linkedin.com',
  'login', 'signup', 'sign-in', 'password-reset', 'forgot_password',
  'orders', 'cart', 'checkout', 'my-items', 'lists', 'registries',
  '/ip/', '/plus', '/apps', '/download',
];

function isBlacklisted(url) {
  const lower = url.toLowerCase();
  return URL_BLACKLIST.some(term => lower.includes(term));
}

function scoreLink(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (url.hostname !== new URL(baseUrl).hostname) return -1;
    const path = url.pathname.toLowerCase();
    if (isBlacklisted(url.href)) return -1;
    if (path === '/') return 90;
    let score = 50;
    for (const keywords of Object.values(PAGE_TYPE_KEYWORDS)) {
      if (keywords.some(kw => path.includes(kw))) {
        score += 30;
        break;
      }
    }
    const depth = path.split('/').filter(Boolean).length;
    score -= depth * 5;
    return Math.max(score, 0);
  } catch {
    return -1;
  }
}

function extractVisibleText($) {
  $('script, style, nav, footer, header, noscript, iframe, svg, img, [aria-hidden="true"]').remove();
  return ($('body').text() || '').replace(/\s+/g, ' ').trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function countJobs(html) {
  const $ = cheerio.load(html);
  const selectors = ['.job', '.position', '.opening', '.job-listing', '[class*="job"]', '[class*="position"]', '[class*="opening"]', 'article', '.card', 'li'];
  let maxCount = 0;
  for (const sel of selectors) {
    const elements = $(sel);
    const jobLike = elements.filter((i, el) => {
      const t = $(el).text().toLowerCase();
      return /\b(engineer|developer|manager|designer|sales|marketing|support|analyst|specialist|associate|director|vp|representative|consultant)\b/i.test(t);
    });
    maxCount = Math.max(maxCount, jobLike.length);
  }
  return maxCount;
}

async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });
    if (response.status === 403 || response.status === 404) return null;
    return response;
  } catch (err) {
    return null;
  }
}

function classifyPageType(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/') return 'homepage';
  for (const [type, keywords] of Object.entries(PAGE_TYPE_KEYWORDS)) {
    if (keywords.some(kw => path.includes(kw))) return type;
  }
  return 'other';
}

async function scanCompany(company, scanRunId) {
  let website = company.website_url;
  if (!website || website.includes('linkedin.com')) return;
  if (!website.startsWith('http')) website = 'https://' + website;

  const homeRes = await fetchPage(website);
  if (!homeRes) return;

  const $ = cheerio.load(homeRes.data);
  const homepageLinks = [];
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) homepageLinks.push(href);
  });

  const scored = homepageLinks
    .map(href => ({ href, score: scoreLink(href, website) }))
    .filter(link => link.score >= 0)
    .sort((a, b) => b.score - a.score);

  const uniqueUrls = new Set();
  const selected = [new URL(website).href];
  uniqueUrls.add(selected[0]);
  for (const { href } of scored) {
    const url = new URL(href, website).href;
    if (!uniqueUrls.has(url)) {
      uniqueUrls.add(url);
      selected.push(url);
      if (selected.length >= MAX_PAGES_PER_COMPANY) break;
    }
  }

  const limit = pLimit(MAX_CONCURRENT_PAGES);
  const pageResults = await Promise.all(
    selected.map(pageUrl =>
      limit(async () => {
        const res = await fetchPage(pageUrl);
        if (!res) return null;
        const $ = cheerio.load(res.data);
        const cleanedText = extractVisibleText($);
        const textHash = hashText(cleanedText);
        const pageType = classifyPageType(pageUrl);
        let jobCount = null;
        if (pageType === 'careers') jobCount = countJobs(res.data);
        return { pageUrl, pageType, cleanedText, textHash, jobCount };
      })
    )
  );

  const { data: existingPages } = await supabase
    .from('company_pages')
    .select('id, page_url')
    .eq('company_id', company.id)
    .eq('is_active', true);
  const existingMap = new Map(existingPages?.map(p => [p.page_url, p.id]) || []);
  const scannedPageIds = [];

  for (const result of pageResults) {
    if (!result) continue;
    const { pageUrl, pageType, cleanedText, textHash, jobCount } = result;
    let pageId = existingMap.get(pageUrl);
    if (!pageId) {
      const { data: newPage } = await supabase
        .from('company_pages')
        .insert({ company_id: company.id, page_url: pageUrl, page_type: pageType, is_active: true, last_status: 'pending' })
        .select('id')
        .single();
      pageId = newPage?.id;
    }
    if (!pageId) continue;
    scannedPageIds.push(pageId);

    const { data: lastSnap } = await supabase
      .from('page_snapshots')
      .select('text_hash')
      .eq('company_page_id', pageId)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let status = 'ok';
    if (!lastSnap || lastSnap.text_hash !== textHash) status = 'changed';

    await supabase.from('page_snapshots').insert({
      company_page_id: pageId,
      scan_run_id: scanRunId,
      cleaned_text: cleanedText,
      text_hash: textHash,
      job_count: jobCount,
    });

    await supabase.from('company_pages')
      .update({ last_scan_at: new Date().toISOString(), last_status: status, signals_generated: false, job_count: jobCount })
      .eq('id', pageId);
  }

  for (const [url, pageId] of existingMap.entries()) {
    if (!scannedPageIds.includes(pageId)) {
      await supabase.from('company_pages')
        .update({ last_status: 'disappeared', is_active: false })
        .eq('id', pageId);
    }
  }
}

async function main() {
  console.log('Starting fast scan...');
  const { data: run } = await supabase
    .from('scan_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  const scanRunId = run.id;

  const { data: companies } = await supabase
    .from('companies')
    .select('id, company_name, website_url')
    .not('website_url', 'is', null);

  if (!companies || companies.length === 0) {
    console.log('No companies to scan.');
    await supabase.from('scan_runs').update({ status: 'completed', companies_scanned: 0 }).eq('id', scanRunId);
    return;
  }

  let companiesScanned = 0, pagesScanned = 0, errors = 0;
  for (const company of companies) {
    try {
      await scanCompany(company, scanRunId);
      companiesScanned++;
    } catch (e) {
      errors++;
      console.error(`Company ${company.company_name} failed: ${e.message}`);
    }
  }

  const { count } = await supabase
    .from('page_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('scan_run_id', scanRunId);
  pagesScanned = count || 0;

  await supabase.from('scan_runs')
    .update({ finished_at: new Date().toISOString(), status: 'completed', companies_scanned: companiesScanned, pages_scanned: pagesScanned, errors })
    .eq('id', scanRunId);

  console.log('Scan complete!');
}

main().catch(console.error);
