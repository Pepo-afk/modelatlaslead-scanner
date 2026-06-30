const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

// Keywords that indicate signals
const KEYWORDS = {
  funding: ['raised', 'funding', 'series a', 'series b', 'series c', 'investment', 'backed by', 'million', 'billion', 'seed round'],
  hiring: ['hiring', 'join us', 'we\'re growing', 'new team', 'expanding team', 'careers', 'open positions', 'now hiring'],
  launch: ['launch', 'announcing', 'introducing', 'new product', 'now available', 'released'],
  partnership: ['partnership', 'partner with', 'integrates with', 'collaboration', 'alliance'],
  expansion: ['new office', 'expanding to', 'now in ', 'new location', 'global expansion'],
  rebranding: ['rebrand', 'new look', 'new name', 'new logo', 'refresh']
};

async function fetchWithTimeout(url, timeout = 15000) {
  try {
    const response = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      maxRedirects: 5
    });
    return response.data;
  } catch (e) {
    console.log(`Failed to fetch ${url}: ${e.message}`);
    return null;
  }
}

function hashHtml(html) {
  return crypto.createHash('md5').update(html).digest('hex');
}

function discoverLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];
  
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    
    const fullUrl = new URL(href, baseUrl).href;
    const text = $(el).text().toLowerCase();
    const urlLower = fullUrl.toLowerCase();
    
    let score = 0;
    if (urlLower.includes('career') || urlLower.includes('job') || text.includes('career') || text.includes('job')) score += 10;
    if (urlLower.includes('blog') || urlLower.includes('news') || text.includes('blog') || text.includes('news')) score += 8;
    if (urlLower.includes('press') || urlLower.includes('about') || text.includes('press')) score += 5;
    
    if (score > 0) {
      links.push({ url: fullUrl, score, type: score >= 10 ? 'careers' : score >= 8 ? 'blog' : 'press' });
    }
  });
  
  const seen = new Map();
  for (const link of links) {
    if (!seen.has(link.url) || seen.get(link.url).score < link.score) {
      seen.set(link.url, link);
    }
  }
  
  return Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, 5);
}

function countJobs(html) {
  const $ = cheerio.load(html);
  
  const selectors = [
    '.job', '.position', '.opening', '.job-listing',
    '[class*="job"]', '[class*="position"]', '[class*="opening"]',
    '[data-testid*="job"]', 'article', '.card'
  ];
  
  let count = 0;
  for (const selector of selectors) {
    count = Math.max(count, $(selector).length);
  }
  
  const bodyText = $('body').text().toLowerCase();
  const jobMatches = bodyText.match(/software engineer|product manager|sales|marketing|designer|developer/g);
  
  return count > 0 ? count : (jobMatches ? jobMatches.length : 0);
}

function extractBlogTitles(html) {
  const $ = cheerio.load(html);
  const titles = [];
  
  $('h1, h2, h3, .title, .post-title, article h2').each((i, el) => {
    const title = $(el).text().trim();
    if (title.length > 10 && title.length < 200) {
      titles.push(title);
    }
  });
  
  return titles.slice(0, 10);
}

function checkKeywords(text) {
  const lowerText = text.toLowerCase();
  const signals = [];
  
  for (const [type, words] of Object.entries(KEYWORDS)) {
    for (const word of words) {
      if (lowerText.includes(word)) {
        signals.push(type);
        break;
      }
    }
  }
  
  return [...new Set(signals)];
}

async function scanCompany(company) {
  console.log(`\nScanning: ${company.company_name} (${company.company_website})`);
  
  const website = company.company_website.startsWith('http') 
    ? company.company_website 
    : `https://${company.company_website}`;
  
  // 1. Fetch homepage
  const homepageHtml = await fetchWithTimeout(website);
  if (!homepageHtml) {
    console.log('  Failed to fetch homepage');
    return [];
  }
  
  const homepageHash = hashHtml(homepageHtml);
  
  // 2. Discover links
  const discoveredLinks = discoverLinks(homepageHtml, website);
  console.log(`  Discovered ${discoveredLinks.length} pages: ${discoveredLinks.map(l => l.type).join(', ')}`);
  
  // 3. Fetch careers page
  let careersUrl = discoveredLinks.find(l => l.type === 'careers')?.url;
  let careersCount = 0;
  
  if (careersUrl) {
    const careersHtml = await fetchWithTimeout(careersUrl);
    if (careersHtml) {
      careersCount = countJobs(careersHtml);
      console.log(`  Jobs found: ${careersCount}`);
    }
  }
  
  // 4. Fetch blog page
  let blogUrl = discoveredLinks.find(l => l.type === 'blog')?.url;
  let blogTitles = [];
  
  if (blogUrl) {
    const blogHtml = await fetchWithTimeout(blogUrl);
    if (blogHtml) {
      blogTitles = extractBlogTitles(blogHtml);
      console.log(`  Blog titles: ${blogTitles.slice(0, 3).join('; ')}`);
    }
  }
  
  // 5. Get yesterday's snapshot
  const { data: snapshot } = await supabase
    .from('company_snapshots')
    .select('*')
    .eq('company_name', company.company_name)
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  
  const signals = [];
  
  // 6. Compare homepage
  if (snapshot) {
    if (snapshot.homepage_hash !== homepageHash) {
      console.log('  Homepage changed!');
      const homepageSignals = checkKeywords(homepageHtml);
      for (const type of homepageSignals) {
        signals.push({
          type,
          description: `Homepage updated with ${type} signal`,
          source_url: website
        });
      }
    }
    
    if (snapshot.careers_count > 0 && careersCount > snapshot.careers_count + 5) {
      console.log(`  Hiring surge: ${snapshot.careers_count} → ${careersCount}`);
      signals.push({
        type: 'hiring',
        description: `Job openings increased from ${snapshot.careers_count} to ${careersCount}`,
        source_url: careersUrl || website
      });
    }
    
    const newTitles = blogTitles.filter(t => !snapshot.last_blog_titles?.includes(t));
    for (const title of newTitles) {
      const titleSignals = checkKeywords(title);
      for (const type of titleSignals) {
        signals.push({
          type,
          description: `Blog post: ${title}`,
          source_url: blogUrl || website
        });
      }
    }
  } else {
    console.log('  First scan - saving baseline');
  }
  
  // 7. Save new snapshot
  await supabase.from('company_snapshots').insert({
    company_name: company.company_name,
    company_website: website,
    homepage_html: homepageHtml.substring(0, 50000),
    homepage_hash: homepageHash,
    careers_url: careersUrl,
    careers_count: careersCount,
    blog_urls: blogUrl ? [blogUrl] : [],
    last_blog_titles: blogTitles,
    checked_at: new Date().toISOString()
  });
  
  console.log(`  Signals found: ${signals.length}`);
  return signals;
}

async function main() {
  console.log('Starting homepage scan...');
  
  // Get all unique companies from leads
  const { data: leads, error } = await supabase
    .from('leads')
    .select('company_name, company_website')
    .not('company_website', 'is', null);
  
  if (error || !leads || leads.length === 0) {
    console.log('No leads with websites found');
    return;
  }
  
  // Remove duplicates
  const uniqueCompanies = [];
  const seen = new Set();
  for (const lead of leads) {
    if (!seen.has(lead.company_name)) {
      seen.add(lead.company_name);
      uniqueCompanies.push(lead);
    }
  }
  
  console.log(`Found ${uniqueCompanies.length} unique companies`);
  
  // Scan each company
  for (const company of uniqueCompanies) {
    try {
      const signals = await scanCompany(company);
      
      // Save signals to database
      for (const signal of signals) {
        // Find all users tracking this company
        const { data: companyLeads } = await supabase
          .from('leads')
          .select('id, user_id')
          .eq('company_name', company.company_name);
        
        for (const lead of companyLeads || []) {
          // Check if signal already exists
          const { data: existing } = await supabase
            .from('signals')
            .select('id')
            .eq('lead_id', lead.id)
            .eq('description', signal.description)
            .maybeSingle();
          
          if (!existing) {
            await supabase.from('signals').insert({
              lead_id: lead.id,
              user_id: lead.user_id,
              type: signal.type,
              description: signal.description,
              source_url: signal.source_url,
              email_status: 'pending',
              email_subject: `Quick note — ${company.company_name} update`
            });
            console.log(`  Saved signal for ${company.company_name}`);
          }
        }
      }
    } catch (e) {
      console.error(`Error scanning ${company.company_name}:`, e.message);
    }
  }
  
  console.log('\nScan complete!');
}

main().catch(console.error);
