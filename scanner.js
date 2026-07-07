const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const MAX_PAGES = 15;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_TYPE_KEYWORDS = {
  blog: ['blog', 'news', 'articles', 'stories'],
  careers: ['careers', 'jobs', 'work', 'team'],
  press: ['press', 'media', 'newsroom'],
  about: ['about', 'company', 'team'],
};

function scoreLink(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (url.hostname !== new URL(baseUrl).hostname) return -1;
    if (url.pathname === '/') return 90;
    const path = url.pathname.toLowerCase();
    let score = 50;
    for (const [type, keywords] of Object.entries(PAGE_TYPE_KEYWORDS)) {
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

// ---------- JOB COUNTING ----------
function countJobs(html) {
  const $ = cheerio.load(html);
  // Look for elements that likely contain individual job postings
  const selectors = [
    '.job', '.position', '.opening', '.job-listing',
    '[class*="job"]', '[class*="position"]', '[class*="opening"]',
    'article', '.card', 'li'
  ];
  let maxCount = 0;
  for (const sel of selectors) {
    const elements = $(sel);
    // Filter to those whose text contains typical job title keywords
    const jobLike = elements.filter((i, el) => {
      const t = $(el).text().toLowerCase();
      return /\b(engineer|developer|manager|designer|sales|marketing|support|analyst|specialist|associate|director|vp|representative|consultant)\b/i.test(t);
    });
    maxCount = Math.max(maxCount, jobLike.length);
  }
  return maxCount;
}

// ---------- FETCH WITH RETRY ----------
async function fetchWithTimeout(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': USER_AGENT },
        maxRedirects: 5,
      });
      return response;
    } catch (err) {
      if (i === retries) throw err;
      console.log(`Retry ${i+1} for ${url}`);
    }
  }
}

// ---------- CLASSIFY PAGE TYPE ----------
function classifyPageType(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/') return 'homepage';
  for (const [type, keywords] of Object.entries(PAGE_TYPE_KEYWORDS)) {
    if (keywords.some(kw => path.includes(kw))) return type;
  }
  return 'other';
}

// ---------- SCAN ONE COMPANY ----------
async function scanCompany(company, scanRunId) {
  let website = company.website_url;
  if (!website) return;

  if (!website.startsWith('http://') && !website.startsWith('https://')) {
    website = 'https://' + website;
  }

  try {
    new URL(website);
  } catch {
    console.log(`Skipping ${company.company_name}: invalid URL`);
    return;
  }

  // 1. Fetch homepage, discover links
  let $home, homepageLinks = [];
  try {
    const res = await fetchWithTimeout(website);
    $home = cheerio.load(res.data);
    $home('a[href]').each((i, el) => {
      const href = $home(el).attr('href');
      if (href) homepageLinks.push(href);
    });
  } catch (err) {
    console.error(`Failed to fetch homepage for ${company.company_name}: ${err.message}`);
    return;
  }

  // 2. Score and select top pages (max 15)
  const scored = homepageLinks
    .map(href => ({ href, score: scoreLink(href, website) }))
    .filter(link => link.score >= 0)
    .sort((a, b) => b.score - a.score);

  const uniqueUrls = new Set();
  const selected = [];
  selected.push(new URL(website).href);
  uniqueUrls.add(selected[0]);
  for (const { href } of scored) {
    const url = new URL(href, website).href;
    if (!uniqueUrls.has(url)) {
      uniqueUrls.add(url);
      selected.push(url);
      if (selected.length >= MAX_PAGES) break;
    }
  }

  // 3. Get existing active pages
  const { data: existingPages } = await supabase
    .from('company_pages')
    .select('id, page_url')
    .eq('company_id', company.id)
    .eq('is_active', true);
  const existingUrls = new Map(existingPages?.map(p => [p.page_url, p.id]) || []);
  const scannedPageIds = [];

  for (const pageUrl of selected) {
    let pageId = existingUrls.get(pageUrl);
    const pageType = classifyPageType(pageUrl);
    if (!pageId) {
      const { data: newPage } = await supabase
        .from('company_pages')
        .insert({
          company_id: company.id,
          page_url: pageUrl,
          page_type: pageType,
          is_active: true,
          last_status: 'pending'
        })
        .select('id')
        .single();
      pageId = newPage?.id;
    }
    if (!pageId) continue;
    scannedPageIds.push(pageId);

    try {
      const res = await fetchWithTimeout(pageUrl);
      const html = res.data;
      const $ = cheerio.load(html);
      const cleanedText = extractVisibleText($);
      const textHash = hashText(cleanedText);

      // Count jobs if careers page
      let jobCount = null;
      if (pageType === 'careers') {
        jobCount = countJobs(html);
        console.log(`  Jobs counted: ${jobCount}`);
      }

      const { data: lastSnap } = await supabase
        .from('page_snapshots')
        .select('text_hash')
        .eq('company_page_id', pageId)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let status = 'ok';
      if (!lastSnap || lastSnap.text_hash !== textHash) {
        status = 'changed';
      }

      // Insert snapshot (with job count)
      const { data: newSnap, error: snapErr } = await supabase
        .from('page_snapshots')
        .insert({
          company_page_id: pageId,
          scan_run_id: scanRunId,
          cleaned_text: cleanedText,
          text_hash: textHash,
          http_status: res.status,
          job_count: jobCount,
        })
        .select('id')
        .single();

      if (snapErr) {
        console.error(`Snapshot insert error: ${snapErr.message}`);
      }

      // Update company_pages status and job_count
      await supabase.from('company_pages')
        .update({
          last_scan_at: new Date().toISOString(),
          last_status: status,
          signals_generated: false,
          job_count: jobCount,
        })
        .eq('id', pageId);

    } catch (err) {
      if (err.response && err.response.status === 404) {
        const { data: lastSnap } = await supabase
          .from('page_snapshots')
          .select('id')
          .eq('company_page_id', pageId)
          .limit(1)
          .maybeSingle();
        if (lastSnap) {
          await supabase.from('page_snapshots').insert({
            company_page_id: pageId,
            scan_run_id: scanRunId,
            cleaned_text: null,
            text_hash: '404',
            http_status: 404,
            error_message: 'Page disappeared'
          });
          await supabase.from('company_pages')
            .update({ last_scan_at: new Date().toISOString(), last_status: 'disappeared' })
            .eq('id', pageId);
        } else {
          await supabase.from('company_pages')
            .update({ last_scan_at: new Date().toISOString(), last_status: 'error' })
            .eq('id', pageId);
        }
      } else {
        await supabase.from('page_snapshots').insert({
          company_page_id: pageId,
          scan_run_id: scanRunId,
          cleaned_text: null,
          text_hash: 'error',
          error_message: err.message
        });
        await supabase.from('company_pages')
          .update({ last_scan_at: new Date().toISOString(), last_status: 'error' })
          .eq('id', pageId);
      }
    }
  }

  // 4. Mark missing pages as disappeared
  for (const [url, pageId] of existingUrls.entries()) {
    if (!scannedPageIds.includes(pageId)) {
      const { data: snap } = await supabase
        .from('page_snapshots')
        .select('id')
        .eq('company_page_id', pageId)
        .limit(1)
        .maybeSingle();
      if (snap) {
        await supabase.from('company_pages')
          .update({ last_status: 'disappeared', is_active: false })
          .eq('id', pageId);
      } else {
        await supabase.from('company_pages')
          .update({ is_active: false })
          .eq('id', pageId);
      }
    }
  }
}

// ---------- MAIN ----------
async function main() {
  console.log('Starting scan...');

  const { data: run } = await supabase
    .from('scan_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  const scanRunId = run.id;

  try {
    const { data: companies } = await supabase
      .from('companies')
      .select('id, company_name, website_url')
      .not('website_url', 'is', null);

    if (!companies || companies.length === 0) {
      console.log('No companies to scan.');
      await supabase.from('scan_runs').update({ finished_at: new Date().toISOString(), status: 'completed', companies_scanned: 0 }).eq('id', scanRunId);
      return;
    }

    let companiesScanned = 0, pagesScanned = 0, errors = 0;
    for (const company of companies) {
      try {
        await scanCompany(company, scanRunId);
        companiesScanned++;
        const { count } = await supabase
          .from('page_snapshots')
          .select('id', { count: 'exact', head: true })
          .eq('scan_run_id', scanRunId);
        pagesScanned = count || 0;
      } catch (e) {
        errors++;
        console.error(`Company ${company.company_name} failed: ${e.message}`);
      }
    }

    await supabase.from('scan_runs')
      .update({
        finished_at: new Date().toISOString(),
        status: 'completed',
        companies_scanned: companiesScanned,
        pages_scanned: pagesScanned,
        errors
      })
      .eq('id', scanRunId);
  } catch (err) {
    await supabase.from('scan_runs')
      .update({
        finished_at: new Date().toISOString(),
        status: 'failed',
        error_message: err.message
      })
      .eq('id', scanRunId);
    throw err;
  }

  console.log('Scan complete!');
}

main().catch(console.error);
