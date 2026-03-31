import { Resend } from 'resend';
import {
  getUnsentJobListings,
  getUnsentJobListingsCount,
  markAllUnsentAsAlerted,
} from '../db/supabase';

const MAX_EMAIL_ROLES = 50;

export async function sendDigestEmail(subjectOverride?: string): Promise<void> {
  const totalCount = await getUnsentJobListingsCount();

  if (totalCount === 0) {
    console.log('No unsent listings — skipping digest email');
    return;
  }

  // Fetch only the 50 most recent by first_seen_at
  const listings = await getUnsentJobListings(MAX_EMAIL_ROLES);
  const isTruncated = totalCount > MAX_EMAIL_ROLES;

  console.log(`Sending digest: ${listings.length} roles in email (${totalCount} total unsent)`);

  const now = new Date();
  const dayDate = now.toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const subject =
    subjectOverride || `🚀 ${totalCount} new sales roles on YC — ${dayDate}`;

  const body = listings
    .map((l) => {
      const postedAgo = formatTimeAgo(l.posted_at);
      const companySlug = l.company_url
        ? l.company_url
        : `https://www.ycombinator.com/companies/${l.company_name.toLowerCase().replace(/\s+/g, '-')}`;
      const lines = [
        '────────────────────────────────────',
        `${l.company_name} (${l.company_batch || '??'}) — ${l.role_title}`,
      ];
      if (l.location) lines.push(`📍 ${l.location}`);
      if (l.salary_range) lines.push(`💰 ${l.salary_range}`);
      if (l.min_experience) lines.push(`🎯 ${l.min_experience} experience`);
      lines.push(
        `Posted: ${postedAgo}`,
        `→ YC profile: ${companySlug}`,
        `→ Job listing: ${l.role_url}`,
        `Matched keyword: ${l.matched_keyword}`,
      );
      return lines.join('\n');
    })
    .join('\n\n');

  const footer = isTruncated
    ? `Showing ${MAX_EMAIL_ROLES} most recent of ${totalCount} total matches. Future daily digests will show only new roles added each day.`
    : `${totalCount} total new roles found.`;

  const fullBody = `${body}\n\n────────────────────────────────────\n${footer}\n`;

  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const toEmail = process.env.RESEND_TO_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;

  if (!fromEmail || !toEmail || !apiKey) {
    throw new Error('Missing RESEND_FROM_EMAIL, RESEND_TO_EMAIL, or RESEND_API_KEY');
  }

  const resend = new Resend(apiKey);

  console.log(`Calling Resend API (body length: ${fullBody.length} chars)...`);

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to: toEmail,
    subject,
    text: fullBody,
  });

  console.log('Resend response:', JSON.stringify({ data, error }));

  if (error || !data?.id) {
    throw new Error(
      `Resend failed: ${error?.message || 'no email ID returned'} (${JSON.stringify(error)})`
    );
  }

  console.log(`Digest email sent: "${subject}" (id: ${data.id})`);

  // Only mark as alerted after confirmed send
  await markAllUnsentAsAlerted();
  console.log(`Marked ${totalCount} listings as alerted`);
}

function formatTimeAgo(dateStr: string): string {
  const posted = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - posted.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours} hours ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}
