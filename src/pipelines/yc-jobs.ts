import { SALES_KEYWORDS } from '../config/keywords';
import {
  jobIdExists,
  insertJobListings,
  insertDedupLog,
} from '../db/supabase';
import type { YCJobListing } from '../types';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const YC_JOBS_URL = 'https://www.ycombinator.com/jobs';
const YC_COMPANIES_API = 'https://yc-oss.github.io/api/companies/all.json';

/** Always scrape exactly this many company pages per cron run. */
const PAGES_PER_RUN = 3;

/** Stop processing once we hit this many consecutive known job IDs. */
const DEDUP_STOP_THRESHOLD = 5;

// ── Keyword matching ──

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

export function matchKeywords(title: string): string | null {
  const norm = normalise(title);

  for (const [group, keywords] of Object.entries(SALES_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalise(kw);
      if (kwNorm.length <= 4) {
        if (new RegExp(`\\b${kwNorm}\\b`).test(norm)) return `${group}:${kw}`;
      } else {
        if (norm.includes(kwNorm)) return `${group}:${kw}`;
      }
    }
  }

  for (const [group, keywords] of Object.entries(SALES_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalise(kw);
      if (kwNorm.length < 12) continue;
      if (fuzzyMatch(norm, kwNorm, 2)) return `${group}:${kw}`;
    }
  }

  return null;
}

function fuzzyMatch(text: string, keyword: string, maxDist: number): boolean {
  const kLen = keyword.length;
  if (kLen === 0) return false;
  for (let i = 0; i <= text.length - kLen; i++) {
    if (levenshtein(text.slice(i, i + kLen), keyword) <= maxDist) return true;
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// ── Scraper ──

interface RawJob {
  jobId: string;
  companyName: string;
  companyBatch: string;
  companyUrl: string;
  roleTitle: string;
  roleUrl: string;
  postedAt: string;
  location: string;
  salaryRange: string;
  minExperience: string;
}

interface YCEmbeddedJob {
  id: number;
  title: string;
  url: string;
  companyName: string;
  companyBatchName: string | null;
  companyUrl: string;
  lastActive: string;
  location: string;
  salaryRange: string;
  minExperience: string;
  [key: string]: unknown;
}

export function extractJobsFromHtml(html: string): RawJob[] {
  const marker = '[{&quot;id&quot;';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];

  const decoded = html.slice(idx)
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\\u0026/g, '&');

  let depth = 0, end = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] === '[') depth++;
    if (decoded[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === 0) return [];

  let jobs: YCEmbeddedJob[];
  try { jobs = JSON.parse(decoded.slice(0, end)); }
  catch { return []; }

  return jobs.map((j) => ({
    jobId: String(j.id),
    companyName: j.companyName || '',
    companyBatch: j.companyBatchName || '',
    companyUrl: j.companyUrl ? `https://www.ycombinator.com${j.companyUrl}` : '',
    roleTitle: j.title || '',
    roleUrl: j.url ? `https://www.ycombinator.com${j.url}` : '',
    postedAt: relativeTimeToISO(j.lastActive || ''),
    location: j.location || '',
    salaryRange: j.salaryRange || '',
    minExperience: j.minExperience || '',
  }));
}

function relativeTimeToISO(text: string): string {
  const now = Date.now();
  const num = parseInt(text.replace(/[^0-9]/g, '')) || 1;

  if (text.includes('hour')) return new Date(now - num * 60 * 60 * 1000).toISOString();
  if (text.includes('day')) return new Date(now - num * 24 * 60 * 60 * 1000).toISOString();
  if (text.includes('month')) return new Date(now - num * 30 * 24 * 60 * 60 * 1000).toISOString();
  if (text.includes('year')) return new Date(now - num * 365 * 24 * 60 * 60 * 1000).toISOString();

  return new Date(now).toISOString();
}

export function batchSortKey(batch: string): number {
  const match = batch.match(/(Winter|Summer|Fall|Spring)\s+(\d{4})/);
  if (!match) return 0;
  const year = parseInt(match[2]);
  const season = match[1] === 'Winter' ? 0.1 : match[1] === 'Spring' ? 0.3 : match[1] === 'Summer' ? 0.5 : 0.7;
  return -(year + season);
}

export interface YCCompany {
  name: string;
  slug: string;
  batch: string;
  isHiring: boolean;
  [key: string]: unknown;
}

/**
 * Scrape YC job listings:
 *   1. Main /jobs page — 20 featured listings (1 request)
 *   2. YC OSS API → top PAGES_PER_RUN company pages sorted newest first
 *      (1s delay between requests)
 *
 * Always exactly PAGES_PER_RUN company pages. No baseline logic —
 * use scripts/seed-database.ts locally for the initial full scrape.
 */
export async function scrapeYCJobs(): Promise<RawJob[]> {
  const allJobs = new Map<string, RawJob>();

  // Source 1: Main /jobs page
  console.log(`[SCRAPE] Fetching ${YC_JOBS_URL}...`);
  try {
    const res = await fetch(YC_JOBS_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const jobs = extractJobsFromHtml(await res.text());
      for (const j of jobs) allJobs.set(j.jobId, j);
      console.log(`[SCRAPE] Main page: ${jobs.length} jobs`);
    }
  } catch (err) {
    console.error('[SCRAPE] Failed to fetch main jobs page:', err);
  }

  // Source 2: Company pages
  console.log(`[SCRAPE] Fetching YC companies API...`);
  try {
    const res = await fetch(YC_COMPANIES_API, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`API returned ${res.status}`);

    const companies = (await res.json()) as YCCompany[];
    const hiring = companies
      .filter((c) => c.isHiring)
      .sort((a, b) => batchSortKey(a.batch) - batchSortKey(b.batch));

    const batch = hiring.slice(0, PAGES_PER_RUN);
    console.log(`[SCRAPE] ${hiring.length} hiring companies, scraping ${batch.length} newest...`);

    for (const company of batch) {
      const url = `https://www.ycombinator.com/companies/${company.slug}`;
      try {
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(10_000),
        });
        if (!pageRes.ok) continue;

        const jobs = extractJobsFromHtml(await pageRes.text());
        for (const j of jobs) {
          if (!allJobs.has(j.jobId)) allJobs.set(j.jobId, j);
        }

        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        // skip failed page
      }
    }

    console.log(`[SCRAPE] Total: ${allJobs.size} unique jobs`);
  } catch (err) {
    console.error('[SCRAPE] Failed to process YC companies:', err);
  }

  return Array.from(allJobs.values());
}

// ── Incremental match + queue ──

export async function queueNewListings(): Promise<YCJobListing[]> {
  const rawJobs = await scrapeYCJobs();
  console.log(`[QUEUE] Scraped ${rawJobs.length} total jobs`);

  const matched: YCJobListing[] = [];
  const seenJobIds = new Set<string>();
  let newCount = 0;
  let skippedDedup = 0;
  let skippedKeyword = 0;
  let consecutiveExisting = 0;

  for (const job of rawJobs) {
    if (seenJobIds.has(job.jobId)) continue;
    seenJobIds.add(job.jobId);

    let exists = false;
    try {
      exists = await jobIdExists(job.jobId);
    } catch (err) {
      console.error(`[QUEUE] Supabase jobIdExists error for ${job.jobId}:`, err);
    }

    if (exists) {
      skippedDedup++;
      consecutiveExisting++;
      if (consecutiveExisting >= DEDUP_STOP_THRESHOLD) {
        console.log(`[QUEUE] Hit ${DEDUP_STOP_THRESHOLD} consecutive known jobs — caught up, stopping`);
        break;
      }
      continue;
    }

    consecutiveExisting = 0;
    newCount++;

    const keyword = matchKeywords(job.roleTitle);
    if (!keyword) {
      skippedKeyword++;
      continue;
    }

    console.log(`[QUEUE] ✓ MATCHED: "${job.roleTitle}" (${job.companyName}) → ${keyword}`);

    matched.push({
      job_id: job.jobId,
      company_name: job.companyName,
      company_batch: job.companyBatch,
      company_url: job.companyUrl,
      role_title: job.roleTitle,
      role_url: job.roleUrl,
      matched_keyword: keyword,
      posted_at: job.postedAt,
      location: job.location,
      salary_range: job.salaryRange,
      min_experience: job.minExperience,
    });
  }

  console.log(`[QUEUE] Summary: ${rawJobs.length} scraped, ${newCount} new, ${skippedDedup} deduped, ${skippedKeyword} no keyword, ${matched.length} matched`);

  if (matched.length > 0) {
    try {
      const now = new Date().toISOString();
      await insertJobListings(matched.map((m) => ({ ...m, first_seen_at: now })));
      for (const m of matched) await insertDedupLog('yc_jobs', m.job_id);
      console.log(`[QUEUE] Inserted ${matched.length} rows`);
    } catch (err) {
      console.error(`[QUEUE] Supabase insert FAILED:`, err);
    }
  } else {
    console.log('[QUEUE] No matched listings to insert');
  }

  return matched;
}

// ── Local test mode ──

if (require.main === module) {
  (async () => {
    console.log('\n=== YC Jobs Scraper — Local Test ===\n');

    const rawJobs = await scrapeYCJobs();
    console.log(`\nScraped ${rawJobs.length} total jobs from YC\n`);

    for (const job of rawJobs.slice(0, 10)) {
      console.log(`  [${job.companyBatch || '??'}] ${job.companyName} — ${job.roleTitle}`);
      console.log(`       ${job.roleUrl}`);
    }
    if (rawJobs.length > 10) console.log(`  ... and ${rawJobs.length - 10} more\n`);

    console.log('\n--- Keyword Matches ---\n');
    let matchCount = 0;
    for (const job of rawJobs) {
      const keyword = matchKeywords(job.roleTitle);
      if (keyword) {
        matchCount++;
        console.log(`  ✓ ${job.companyName} (${job.companyBatch || '??'}) — ${job.roleTitle}`);
        console.log(`    Matched: ${keyword}`);
        console.log(`    URL: ${job.roleUrl}\n`);
      }
    }
    console.log(`Total: ${matchCount} matches out of ${rawJobs.length} jobs\n`);
    process.exit(0);
  })().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
}
