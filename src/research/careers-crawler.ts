import * as cheerio from 'cheerio';
import type { CareersResult } from '../types';

const CAREERS_PATHS = ['/careers', '/jobs', '/join', '/work-with-us'];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ATS_PATTERNS: Record<string, RegExp> = {
  Lever: /lever\.co/i,
  Greenhouse: /greenhouse\.io|boards\.greenhouse/i,
  Workable: /workable\.com|apply\.workable/i,
  Ashby: /ashbyhq\.com/i,
};

const DEPT_KEYWORDS: Record<string, string[]> = {
  engineering: [
    'engineer', 'developer', 'software', 'frontend', 'backend',
    'fullstack', 'full-stack', 'devops', 'sre', 'infrastructure',
    'platform', 'machine learning', 'ml ', 'data engineer', 'mobile',
    'ios', 'android', 'qa', 'security',
  ],
  sales: [
    'sales', 'account executive', 'sdr', 'bdr', 'business development',
    'gtm', 'go-to-market', 'revenue',
  ],
  ops: [
    'operations', 'ops', 'office manager', 'executive assistant',
    'people', 'hr', 'finance', 'legal', 'recruiting', 'talent',
  ],
  design: [
    'design', 'ux', 'ui', 'product design', 'graphic', 'brand', 'creative',
  ],
  data: [
    'data scientist', 'data analyst', 'analytics', 'bi ',
    'business intelligence',
  ],
};

function classifyRole(title: string): string {
  const lower = title.toLowerCase();
  for (const [dept, keywords] of Object.entries(DEPT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return dept;
    }
  }
  return 'other';
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return { html, finalUrl: res.url };
  } catch {
    return null;
  }
}

/**
 * Find the careers page URL by scanning the homepage HTML for links,
 * then falling back to direct path probing.
 */
async function findCareersUrl(baseUrl: string): Promise<string | null> {
  // Step 1: Fetch homepage and look for careers links
  const homepage = await fetchHtml(baseUrl);
  if (homepage) {
    const $ = cheerio.load(homepage.html);
    for (const el of $('a[href]').toArray()) {
      const href = ($(el).attr('href') || '').toLowerCase();
      for (const path of CAREERS_PATHS) {
        if (href.includes(path)) {
          const raw = $(el).attr('href') || '';
          // Resolve relative URLs
          try {
            return new URL(raw, baseUrl).href;
          } catch {
            return `${baseUrl}${raw}`;
          }
        }
      }
    }
  }

  // Step 2: Probe direct paths
  for (const path of CAREERS_PATHS) {
    const tryUrl = `${baseUrl}${path}`;
    const result = await fetchHtml(tryUrl);
    if (result) return result.finalUrl;
  }

  return null;
}

/**
 * Extract role titles from careers page HTML using common selectors.
 */
function extractRoleTitles($: cheerio.CheerioAPI): string[] {
  const titles: string[] = [];

  // Try structured selectors first
  const selectors = [
    '[class*="job"] h3', '[class*="job"] h4',
    '[class*="position"] h3', '[class*="position"] h4',
    '[class*="opening"] h3', '[class*="opening"] a',
    '[class*="role"] h3', '[class*="role"] a',
    '.posting-title', '[data-qa="posting-name"]',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 100) {
        titles.push(text);
      }
    });
    if (titles.length > 0) return titles;
  }

  // Fallback: links that look like job postings
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (
      text.length > 5 &&
      text.length < 100 &&
      (href.includes('/job') || href.includes('/position') || href.includes('/opening'))
    ) {
      titles.push(text);
    }
  });

  // Fallback: h3/h4 inside list items (common careers page pattern)
  if (titles.length === 0) {
    $('li h3, li h4').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 100) {
        titles.push(text);
      }
    });
  }

  return titles;
}

/**
 * Crawl company careers page using HTTP fetch + cheerio.
 * Detects ATS, scrapes open roles, categorises by department.
 */
export async function crawlCareersPage(
  companyUrl: string
): Promise<CareersResult | null> {
  const baseUrl = companyUrl.replace(/\/+$/, '');

  // Find the careers page
  const careersUrl = await findCareersUrl(baseUrl);
  if (!careersUrl) return null;

  // Fetch the careers page
  const careersPage = await fetchHtml(careersUrl);
  if (!careersPage) return null;

  const html = careersPage.html;
  const $ = cheerio.load(html);

  // Detect ATS from page content and final URL
  let atsDetected = 'none';
  for (const [name, pattern] of Object.entries(ATS_PATTERNS)) {
    if (pattern.test(html) || pattern.test(careersPage.finalUrl)) {
      atsDetected = name;
      break;
    }
  }
  if (atsDetected === 'none' && /docs\.google\.com\/forms/i.test(html)) {
    atsDetected = 'none (google form)';
  }

  // Extract and classify roles
  const roleTitles = extractRoleTitles($);
  const roles = roleTitles.map((title) => ({
    title,
    department: classifyRole(title),
  }));

  const roleCounts: Record<string, number> = {};
  for (const role of roles) {
    roleCounts[role.department] = (roleCounts[role.department] || 0) + 1;
  }

  return {
    careers_url: careersUrl,
    roles,
    ats_detected: atsDetected,
    role_counts_by_dept: roleCounts,
  };
}
