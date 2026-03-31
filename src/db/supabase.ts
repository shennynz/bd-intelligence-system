import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  client = createClient(url, key);
  return client;
}

// ── Pipeline 1 helpers ──

export async function jobIdExists(jobId: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('yc_job_listings')
    .select('id')
    .eq('job_id', jobId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function insertJobListings(
  rows: {
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
  }[]
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await getSupabase().from('yc_job_listings').insert(rows);
  if (error) throw error;
}

export async function getJobListingCount(): Promise<number> {
  const { count, error } = await getSupabase()
    .from('yc_job_listings')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function getUnsentJobListingsCount(): Promise<number> {
  const { count, error } = await getSupabase()
    .from('yc_job_listings')
    .select('*', { count: 'exact', head: true })
    .is('alerted_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function getUnsentJobListings(limit?: number) {
  let query = getSupabase()
    .from('yc_job_listings')
    .select('*')
    .is('alerted_at', null)
    .order('first_seen_at', { ascending: false });
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function markJobListingsAlerted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await getSupabase()
    .from('yc_job_listings')
    .update({ alerted_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw error;
}

export async function markAllUnsentAsAlerted(): Promise<void> {
  const { error } = await getSupabase()
    .from('yc_job_listings')
    .update({ alerted_at: new Date().toISOString() })
    .is('alerted_at', null);
  if (error) throw error;
}

// ── Dedup log ──

export async function insertDedupLog(
  source: string,
  sourceId: string
): Promise<void> {
  const { error } = await getSupabase().from('dedup_log').insert({
    source,
    source_id: sourceId,
    seen_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// ── Pipeline 2 + 3 helpers ──

export async function storyIdExists(storyId: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('yc_companies_intel')
    .select('id')
    .eq('hn_story_id', storyId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function commentIdExists(commentId: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('yc_companies_intel')
    .select('id')
    .eq('hn_comment_id', commentId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function insertIntelCard(card: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase().from('yc_companies_intel').insert({
    ...card,
    alerted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// ── DNC check ──

export async function isDoNotContact(companyName: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('yc_companies_intel')
    .select('id')
    .ilike('company_name', companyName)
    .eq('do_not_contact', true)
    .limit(1);
  return (data?.length ?? 0) > 0;
}
