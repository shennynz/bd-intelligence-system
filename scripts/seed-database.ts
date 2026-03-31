/**
 * Seed the yc_job_listings table with a full scrape of all YC companies.
 *
 * Run locally — no timeout constraints. Takes ~45 minutes to scrape
 * all ~1400 hiring companies with 2s delay between requests.
 *
 * Usage: npx ts-node scripts/seed-database.ts
 */
import 'dotenv/config';
import {
  extractJobsFromHtml,
  matchKeywords,
  batchSortKey,
  type YCCompany,
} from '../src/pipelines/yc-jobs';
import {
  jobIdExists,
  insertJobListings,
  insertDedupLog,
  getJobListingCount,
} from '../src/db/supabase';
import { sendDigestEmail } from '../src/email/digest';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const YC_JOBS_URL = 'https://www.ycombinator.com/jobs';
const YC_COMPANIES_API = 'https://yc-oss.github.io/api/companies/all.json';
const INSERT_BATCH_SIZE = 100;

(async () => {
  console.log('\n=== Seed Database — Full YC Jobs Scrape ===\n');

  const existingCount = await getJobListingCount();
  console.log(`Current DB rows: ${existingCount}\n`);

  // ── Step 1: Get list of all hiring companies ──

  console.log('Fetching YC companies API...');
  const apiRes = await fetch(YC_COMPANIES_API);
  if (!apiRes.ok) {
    console.error(`API returned ${apiRes.status}`);
    process.exit(1);
  }
  const companies = (await apiRes.json()) as YCCompany[];
  const hiring = companies
    .filter((c) => c.isHiring)
    .sort((a, b) => batchSortKey(a.batch) - batchSortKey(b.batch));

  // Prepend the main /jobs page as "page 0"
  const pages = [
    { slug: '__main__', label: 'Main /jobs page', url: YC_JOBS_URL },
    ...hiring.map((c) => ({
      slug: c.slug,
      label: `${c.name} (${c.batch})`,
      url: `https://www.ycombinator.com/companies/${c.slug}`,
    })),
  ];

  const totalPages = pages.length;
  console.log(`${hiring.length} hiring companies + main page = ${totalPages} pages to scrape\n`);

  // ── Step 2: Scrape all pages, match keywords, collect inserts ──

  let totalJobsScraped = 0;
  let totalMatches = 0;
  let totalDuplicates = 0;
  let failedPages = 0;
  const seenJobIds = new Set<string>();
  const toInsert: {
    job_id: string;
    company_name: string;
    company_batch: string;
    company_url: string;
    role_title: string;
    role_url: string;
    matched_keyword: string;
    posted_at: string;
    first_seen_at: string;
    location: string;
    salary_range: string;
    min_experience: string;
  }[] = [];

  const startTime = Date.now();

  for (let i = 0; i < totalPages; i++) {
    const page = pages[i];

    try {
      const res = await fetch(page.url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { failedPages++; continue; }

      const jobs = extractJobsFromHtml(await res.text());
      let pageMatches = 0;

      for (const job of jobs) {
        if (seenJobIds.has(job.jobId)) continue;
        seenJobIds.add(job.jobId);
        totalJobsScraped++;

        // Dedup against Supabase
        const exists = await jobIdExists(job.jobId);
        if (exists) { totalDuplicates++; continue; }

        // Keyword match
        const keyword = matchKeywords(job.roleTitle);
        if (!keyword) continue;

        pageMatches++;
        totalMatches++;

        toInsert.push({
          job_id: job.jobId,
          company_name: job.companyName,
          company_batch: job.companyBatch,
          company_url: job.companyUrl,
          role_title: job.roleTitle,
          role_url: job.roleUrl,
          matched_keyword: keyword,
          posted_at: job.postedAt,
          first_seen_at: new Date().toISOString(),
          location: job.location,
          salary_range: job.salaryRange,
          min_experience: job.minExperience,
        });
      }

      // Insert in batches as we go (every INSERT_BATCH_SIZE matches)
      if (toInsert.length >= INSERT_BATCH_SIZE) {
        const batch = toInsert.splice(0, INSERT_BATCH_SIZE);
        try {
          await insertJobListings(batch);
          for (const row of batch) await insertDedupLog('yc_jobs', row.job_id);
          console.log(`  → Inserted batch of ${batch.length} rows`);
        } catch (err) {
          console.error(`  → Insert batch failed:`, err);
        }
      }

      if (pageMatches > 0) {
        console.log(`  Page ${i + 1}/${totalPages} — ${page.label} — ${pageMatches} new matches (${totalMatches} total so far)`);
      }
    } catch {
      failedPages++;
    }

    // Progress log every 50 pages
    if ((i + 1) % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const eta = (((Date.now() - startTime) / (i + 1)) * (totalPages - i - 1) / 1000 / 60).toFixed(1);
      console.log(`Page ${i + 1}/${totalPages} — ${totalJobsScraped} jobs scraped, ${totalMatches} matches so far — ${elapsed}min elapsed, ~${eta}min remaining`);
    }

    // 2s delay between requests (skip delay after main page)
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── Step 3: Insert remaining rows ──

  if (toInsert.length > 0) {
    try {
      await insertJobListings(toInsert);
      for (const row of toInsert) await insertDedupLog('yc_jobs', row.job_id);
      console.log(`  → Inserted final batch of ${toInsert.length} rows`);
    } catch (err) {
      console.error(`  → Final insert batch failed:`, err);
    }
  }

  // ── Summary ──

  const finalCount = await getJobListingCount();
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n════════════════════════════════════════');
  console.log(`Seed complete — ${totalJobsScraped} jobs scraped, ${totalMatches} matches saved`);
  console.log(`  Pages: ${totalPages - failedPages} succeeded, ${failedPages} failed`);
  console.log(`  Duplicates skipped: ${totalDuplicates}`);
  console.log(`  DB rows: ${existingCount} → ${finalCount}`);
  console.log(`  Time: ${elapsed} minutes`);
  console.log('════════════════════════════════════════\n');

  // Send digest email with all matches
  if (totalMatches > 0) {
    console.log('Sending baseline digest email...');
    try {
      await sendDigestEmail(
        `🌱 BD Intelligence — Full baseline: ${totalMatches} sales roles found on YC`
      );
      console.log('Digest email sent.\n');
    } catch (err) {
      console.error('Failed to send digest email:', err);
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
