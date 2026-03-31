// ── Pipeline 1: YC Job Listings ──

export interface YCJobListing {
  job_id: string;
  company_name: string;
  company_batch: string;
  company_url: string;
  role_title: string;
  role_url: string;
  matched_keyword: string;
  posted_at: string;
  location: string;
  salary_range: string;
  min_experience: string;
}

// ── Pipeline 2 + 3: Intel Card ──

export interface IntelCard {
  hn_story_id: string | null;
  hn_comment_id: string | null;
  pipeline: 'funding' | 'hn_signal';
  company_name: string;
  company_batch: string;
  company_url: string;
  founder_names: string[];
  founder_backgrounds: FounderBackground[];
  what_they_do: string;
  funding_stage: string;
  funding_amount: string;
  funding_announced_at: string | null;
  use_of_funds: string;
  headcount_estimate: number;
  careers_url: string | null;
  open_roles_count: number;
  open_roles_breakdown: Record<string, number>;
  ats_detected: string;
  sales_hire_count: number;
  opportunity_score: number;
  suggested_angle: string;
  raw_hn_comment: string | null;
  do_not_contact: boolean;
}

export interface FounderBackground {
  name: string;
  prior_companies: string;
  relevant_signal: string;
}

// ── Research module return types ──

export interface YCDirectoryResult {
  batch: string;
  founders: string[];
  one_liner: string;
  team_size: number;
  website: string;
}

export interface CareersResult {
  careers_url: string;
  roles: { title: string; department: string }[];
  ats_detected: string;
  role_counts_by_dept: Record<string, number>;
}

export interface PressResult {
  source: string;
  headline: string;
  quotes: string[];
  url: string;
  published_at: string;
}

export interface HNThreadResult {
  author_replies: string[];
  relevant_comments: string[];
}

export interface BlogResult {
  post_title: string;
  post_excerpt: string;
  post_url: string;
  post_date: string;
}

export interface ResearchData {
  ycDirectory: YCDirectoryResult | null;
  careers: CareersResult | null;
  press: PressResult[];
  hnThread: HNThreadResult | null;
  blog: BlogResult | null;
}
