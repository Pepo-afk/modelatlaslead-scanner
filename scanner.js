const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const MAX_PAGES_PER_COMPANY = 3;
const COMPANY_CONCURRENCY = 15;
const GLOBAL_HTTP_CONCURRENCY = 40;
const FETCH_TIMEOUT_MS = 5000;
const SCAN_BATCH_SIZE = 5000;
const CHUNK_SIZE = 500;
const DB_PAGE_SIZE = 1000;
const MAX_ARTICLE_LINKS = 20;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_TYPE_KEYWORDS = {
  careers: ['careers', 'career', 'jobs', 'job-openings', 'join-us', 'work-with-us', 'join-our-team'],
  blog: ['blog', 'insights', 'articles', 'stories', 'resources/blog'],
  press: ['press', 'newsroom', 'media', 'news'],
};
const CATEGORY_ORDER = ['careers', 'blog', 'press'];

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

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: GLOBAL_HTTP_CONCURRENCY });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: GLOBAL_HTTP_CONCURRENCY });

const httpClient = axios.create({
  timeout: FETCH_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  maxRedirects: 5,
  validateStatus: (status) => status < 500,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  acquire() {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}
const httpSemaphore = new Semaphore(GLOBAL_HTTP_CONCURRENCY);

async function fetchWithLimit(url, conditionalHeaders = {}) {
  await httpSemaphore.acquire();
  try {
    const response = await httpClient.get(url, { headers: conditionalHeaders });
    return response;
  } catch (err) {
    return null;
  } finally {
    httpSemaphore.release();
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

// Extract article links from blog/press index pages.
// Returns an array of { url, title } for links that look like specific articles.
function extractArticleLinks($, baseUrl) {
  const hostname = new URL(baseUrl).hostname;
  const basePath = new URL(baseUrl).pathname.replace(/\/$/, '');
  const articles = [];
  const seen = new Set();

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const text = ($(el).text() || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length < 20 || text.length > 200) return;

    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (url.hostname !== hostname) return;
    if (isBlacklisted(url.href)) return;

    const path = url.pathname.replace(/\/$/, '');
    // Must be deeper than the index page (index is /blog, article is /blog/xyz)
    if (path === basePath) return;
    if (!path.startsWith(basePath + '/') && !basePath.includes(path.split('/').filter(Boolean)[0])) {
      // allow if same first segment
    }

    // Must have at least 2 path segments (avoid /about, /contact)
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return;

    // Skip obvious nav/utility paths
    const lower = path.toLowerCase();
    if (/\/(about|contact|pricing|signup|login|careers|jobs|tags|category|categories|author|page|search|subscribe)\b/.test(lower)) return;
    if (/\.(png|jpg|jpeg|gif|svg|pdf|zip)$/i.test(lower)) return;

    if (seen.has(url.href)) return;
    seen.add(url.href);

    articles.push({ url: url.href, title: text });
  });

  return articles.slice(0, MAX_ARTICLE_LINKS);
}

function scoreLinkForCategory(path, keywords) {
  const lower = path.toLowerCase();
  let best = -1;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      const depth = lower.split('/').filter(Boolean).length;
      const score = 100 - depth * 8 - (lower.indexOf(kw) > 3 ? 5 : 0);
      if (score > best) best = score;
    }
  }
  return best;
}

function pickCandidatePages(links, baseUrl) {
  const hostname = new URL(baseUrl).hostname;
  const bestByCategory = {};

  for (const href of links) {
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.hostname !== hostname) continue;
    if (isBlacklisted(url.href)) continue;
    const path = url.pathname;

    for (const category of CATEGORY_ORDER) {
      const score = scoreLinkForCategory(path, PAGE_TYPE_KEYWORDS[category]);
      if (score < 0) continue;
      if (!bestByCategory[category] || score > bestByCategory[category].score) {
        bestByCategory[category] = { url: url.href, score };
      }
    }
  }

  const selected = [];
  const seenUrls = new Set();
  for (const category of CATEGORY_ORDER) {
    const pick = bestByCategory[category];
    if (pick && !seenUrls.has(pick.url)) {
      selected.push({ url: pick.url, pageType: category });
      seenUrls.add(pick.url);
    }
    if (selected.length >= MAX_PAGES_PER_COMPANY) break;
  }
  return selected.slice(0, MAX_PAGES_PER_COMPANY);
}

async function concurrentMap(items, limit, asyncFn) {
  let index = 0;
  const results = new Array(items.length);
  async function worker() {
    while (index < items.length) {
      const currentIdx = index++;
      results[currentIdx] = await asyncFn(items[currentIdx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
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
      .not('website_url', 'ilike', '%linkedin.com%')
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

async function scanCompany(company, scanRunId) {
  let website = company.website_url;
  if (!website || website.toLowerCase().includes('linkedin.com')) return;
  if (!website.startsWith('http')) website = 'https://' + website;

  const homeRes = await fetchWithLimit(website);
  if (!homeRes || homeRes.status >= 400 || !homeRes.data) return;

  let candidates;
  try {
    const $ = cheerio.load(homeRes.data);
    const links = [];
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) links.push(href);
    });
    candidates = pickCandidatePages(links, website);
    homeRes.data = null;
  } catch {
    return;
  }

  if (candidates.length === 0) return;

  const { data: existingPages } = await supabase
    .from('company_pages')
    .select('id, page_url, page_type, etag, last_modified')
    .eq('company_id', company.id)
    .eq('is_active', true);
  const existingMap = new Map((existingPages || []).map(p => [p.page_url, p]));

  const existingCandidateIds = candidates
    .map(c => existingMap.get(c.url)?.id)
    .filter(Boolean);

  const latestSnapByPage = new Map();
  if (existingCandidateIds.length > 0) {
    const { data: snaps } = await supabase
      .from('page_snapshots')
      .select('company_page_id, text_hash, job_count, fetched_at')
      .in('company_page_id', existingCandidateIds)
      .order('fetched_at', { ascending: false });
    for (const row of snaps || []) {
      if (!latestSnapByPage.has(row.company_page_id)) {
        latestSnapByPage.set(row.company_page_id, row);
      }
    }
  }

  const fetchResults = await Promise.all(candidates.map(async (candidate) => {
    const existing = existingMap.get(candidate.url);
    const conditionalHeaders = {};
    if (existing?.etag) conditionalHeaders['If-None-Match'] = existing.etag;
    if (existing?.last_modified) conditionalHeaders['If-Modified-Since'] = existing.last_modified;

    const res = await fetchWithLimit(candidate.url, conditionalHeaders);
    if (!res) return { candidate, existing, status: 'error' };
    if (res.status === 304) return { candidate, existing, status: 'not_modified' };
    if (res.status >= 400 || !res.data) return { candidate, existing, status: 'error' };

    const $ = cheerio.load(res.data);
    const cleanedText = extractVisibleText($);
    const textHash = hashText(cleanedText);
    const jobCount = candidate.pageType === 'careers' ? countJobs(res.data) : null;
    const etag = res.headers?.etag || null;
    const lastModified = res.headers?.['last-modified'] || null;

    // Extract article links for blog and press pages
    let articleLinks = null;
    if (candidate.pageType === 'blog' || candidate.pageType === 'press') {
      try {
        articleLinks = extractArticleLinks($, candidate.url);
        if (articleLinks.length === 0) articleLinks = null;
      } catch {
        articleLinks = null;
      }
    }

    const result = {
      candidate, existing, status: 'fetched',
      cleanedText, textHash, jobCount, etag, lastModified,
      httpStatus: res.status,
      articleLinks,
    };
    res.data = null;
    return result;
  }));

  const newPageRows = [];
  const pageUpsertRows = [];
  const snapshotRows = [];
  const seenPageUrls = new Set();

  for (const result of fetchResults) {
    const { candidate, existing, status } = result;
    seenPageUrls.add(candidate.url);

    if (status === 'error') continue;

    if (status === 'not_modified') {
      if (existing) {
        pageUpsertRows.push({
          id: existing.id,
          company_id: company.id,
          page_url: candidate.url,
          page_type: candidate.pageType,
          is_active: true,
          last_scan_at: new Date().toISOString(),
          last_status: 'ok',
        });
      }
      continue;
    }

    const { cleanedText, textHash, jobCount, etag, lastModified, httpStatus, articleLinks } = result;
    const prevSnap = existing ? latestSnapByPage.get(existing.id) : null;
    const contentChanged = !prevSnap || prevSnap.text_hash !== textHash;

    if (!existing) {
      newPageRows.push({
        company_id: company.id,
        page_url: candidate.url,
        page_type: candidate.pageType,
        is_active: true,
        last_status: 'pending',
        _pendingSnapshot: { cleanedText, textHash, jobCount, httpStatus, articleLinks },
        _pendingUpdate: { etag, lastModified, jobCount },
      });
    } else {
      pageUpsertRows.push({
        id: existing.id,
        company_id: company.id,
        page_url: candidate.url,
        page_type: candidate.pageType,
        is_active: true,
        last_scan_at: new Date().toISOString(),
        last_status: contentChanged ? 'changed' : 'ok',
        signals_generated: contentChanged ? false : undefined,
        job_count: jobCount,
        etag,
        last_modified: lastModified,
      });
      if (contentChanged) {
        snapshotRows.push({
          company_page_id: existing.id,
          scan_run_id: scanRunId,
          cleaned_text: cleanedText,
          text_hash: textHash,
          job_count: jobCount,
          http_status: httpStatus,
          article_links: articleLinks,
        });
      }
    }
  }

  fetchResults.length = 0;

  if (newPageRows.length > 0) {
    const insertPayload = newPageRows.map(({ _pendingSnapshot, _pendingUpdate, ...row }) => row);
    const { data: inserted, error: insertErr } = await supabase
      .from('company_pages')
      .insert(insertPayload)
      .select('id, page_url');

    if (!insertErr && inserted) {
      const idByUrl = new Map(inserted.map(r => [r.page_url, r.id]));
      for (const row of newPageRows) {
        const id = idByUrl.get(row.page_url);
        if (!id) continue;
        snapshotRows.push({
          company_page_id: id,
          scan_run_id: scanRunId,
          cleaned_text: row._pendingSnapshot.cleanedText,
          text_hash: row._pendingSnapshot.textHash,
          job_count: row._pendingSnapshot.jobCount,
          http_status: row._pendingSnapshot.httpStatus,
          article_links: row._pendingSnapshot.articleLinks,
        });
        pageUpsertRows.push({
          id,
          company_id: company.id,
          page_url: row.page_url,
          page_type: row.page_type,
          is_active: true,
          last_scan_at: new Date().toISOString(),
          last_status: 'changed',
          signals_generated: false,
          job_count: row._pendingUpdate.jobCount,
          etag: row._pendingUpdate.etag,
          last_modified: row._pendingUpdate.lastModified,
        });
      }
    }
  }

  for (const [url, page] of existingMap.entries()) {
    if (!seenPageUrls.has(url)) {
      pageUpsertRows.push({
        id: page.id,
        company_id: company.id,
        page_url: url,
        page_type: page.page_type,
        is_active: false,
        last_status: 'disappeared',
      });
    }
  }

  if (snapshotRows.length > 0) {
    await supabase.from('page_snapshots').insert(snapshotRows);
  }
  if (pageUpsertRows.length > 0) {
    const cleaned = pageUpsertRows.map(row => {
      const out = {};
      for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
      return out;
    });
    await supabase.from('company_pages').upsert(cleaned, { onConflict: 'id' });
  }
}

async function main() {
  console.log(`Starting rotation scan (batch: ${SCAN_BATCH_SIZE}, chunk: ${CHUNK_SIZE})...`);

  const { data: run, error: runErr } = await supabase
    .from('scan_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runErr || !run) {
    console.error('Could not create scan_run:', runErr?.message);
    process.exit(1);
  }
  const scanRunId = run.id;

  const companies = await fetchCompaniesBatch(SCAN_BATCH_SIZE);

  if (!companies || companies.length === 0) {
    console.log('No companies to scan.');
    await supabase
      .from('scan_runs')
      .update({ status: 'completed', companies_scanned: 0 })
      .eq('id', scanRunId);
    return;
  }

  console.log(`Scanning ${companies.length} companies...`);

  const scannedIds = [];
  let companiesScanned = 0;
  let errors = 0;
  const totalChunks = Math.ceil(companies.length / CHUNK_SIZE);

  for (let i = 0; i < companies.length; i += CHUNK_SIZE) {
    const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;
    const slice = companies.slice(i, i + CHUNK_SIZE);
    const memBefore = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`Chunk ${chunkNumber}/${totalChunks} (${slice.length} companies, heap ${memBefore}MB)`);

    await concurrentMap(slice, COMPANY_CONCURRENCY, async (company) => {
      try {
        await scanCompany(company, scanRunId);
        companiesScanned++;
      } catch (e) {
        errors++;
        console.error(`Company ${company.company_name} failed: ${e.message}`);
      } finally {
        scannedIds.push(company.id);
      }
    });

    const memAfter = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`  Chunk ${chunkNumber} done. Heap: ${memAfter}MB`);

    if (typeof global.gc === 'function') global.gc();
  }

  const nowIso = new Date().toISOString();
  const UPDATE_CHUNK = 500;
  for (let i = 0; i < scannedIds.length; i += UPDATE_CHUNK) {
    const slice = scannedIds.slice(i, i + UPDATE_CHUNK);
    const { error: updErr } = await supabase
      .from('companies')
      .update({ last_scanned_at: nowIso })
      .in('id', slice);
    if (updErr) console.error('Failed to update last_scanned_at chunk:', updErr.message);
  }

  const { count } = await supabase
    .from('page_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('scan_run_id', scanRunId);

  await supabase
    .from('scan_runs')
    .update({
      finished_at: new Date().toISOString(),
      status: 'completed',
      companies_scanned: companiesScanned,
      pages_scanned: count || 0,
      errors,
    })
    .eq('id', scanRunId);

  console.log(`Scan complete. Companies: ${companiesScanned}, snapshots: ${count || 0}, errors: ${errors}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
