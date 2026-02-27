#!/usr/bin/env node
/**
 * update-portfolio.ts
 * ─────────────────────────────────────────────────────────────────────
 * Regenerates the /apps/ portfolio index page (WordPress page ID 1905)
 * from all published app pages found in the Neon pipeline_runs table.
 *
 * Usage:
 *   npx tsx scripts/update-portfolio.ts [options]
 *
 * Options:
 *   --dry-run    Show what would be updated without making changes
 */

import { createLogger, getConfig, getDbPool } from '@appspotlight/shared';
import { findPageBySlug, updatePage } from '@appspotlight/publisher';

const log = createLogger('portfolio');

interface AppPageInfo {
  repo_name: string;
  wp_page_url: string;
  app_name: string;
  confidence_score: number;
}

async function getPublishedApps(): Promise<AppPageInfo[]> {
  const pool = getDbPool();

  // Get the most recent successful run per repo that has a WP page
  const result = await pool.query<AppPageInfo>(`
    SELECT DISTINCT ON (repo_name)
      repo_name,
      wp_page_url,
      COALESCE(generated_content->>'app_name', repo_name) as app_name,
      confidence_score
    FROM pipeline_runs
    WHERE status = 'completed'
      AND wp_page_url IS NOT NULL
      AND publish_action IN ('auto_published', 'draft_approved', 'draft_edited')
    ORDER BY repo_name, completed_at DESC
  `);

  return result.rows;
}

function generatePortfolioContent(apps: AppPageInfo[]): string {
  // Sort by confidence score (highest first)
  const sorted = [...apps].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));

  const appCards = sorted.map(app => {
    const name = app.app_name.replace(/\[REVIEW NEEDED\]\s*/g, '');
    return `<div style="background:#1a1a2e;border-radius:16px;padding:2rem;display:flex;flex-direction:column;gap:0.5rem">
  <h3 style="color:#fff;font-family:Poppins,sans-serif;font-size:1.2rem;font-weight:700;margin:0">${escHtml(name)}</h3>
  <a href="${escHtml(app.wp_page_url)}" style="display:inline-block;background:#0078FF;color:#fff;padding:0.5rem 1.5rem;border-radius:8px;text-decoration:none;font-family:Open Sans,sans-serif;font-size:0.9rem;font-weight:600;margin-top:auto;text-align:center;transition:background 0.2s">View Project</a>
</div>`;
  }).join('\n');

  return `<!-- wp:html -->
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&family=Open+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
.page-id-1905 .entry-title,
.page-id-1905 .page-title,
.page-id-1905 h1.entry-title { display: none !important; }
.page-id-1905 #sidebar,
.page-id-1905 .et_right_sidebar #sidebar,
.page-id-1905 .widget-area { display: none !important; }
.page-id-1905 #left-area,
.page-id-1905 .et_right_sidebar #left-area,
.page-id-1905 .et_no_sidebar #left-area { width: 100% !important; max-width: 100% !important; padding: 0 !important; float: none !important; }
.page-id-1905 #main-content .container,
.page-id-1905 #content-area .container,
.page-id-1905 .entry-content .container { max-width: 100% !important; width: 100% !important; padding: 0 !important; }
.page-id-1905 #main-content .et_pb_row { max-width: 100% !important; width: 100% !important; padding: 0 !important; }
.page-id-1905 #main-content { padding-top: 0 !important; }
.page-id-1905 .et_pb_section { padding: 0 !important; }
.page-id-1905 #page-container { padding-top: 0 !important; }
.page-id-1905 .entry-content { margin: 0 !important; padding: 0 !important; }
</style>
<div style="background:#000;min-height:100vh;padding:4rem 2rem;font-family:Open Sans,sans-serif">
  <div style="max-width:1200px;margin:0 auto">
    <h1 style="color:#fff;font-family:Poppins,sans-serif;font-size:3rem;font-weight:900;text-align:center;margin-bottom:0.5rem">Apps &amp; Projects</h1>
    <p style="color:#abb8c3;font-size:1.2rem;text-align:center;margin-bottom:3rem">${sorted.length} projects built and shipped</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.5rem">
      ${appCards}
    </div>
  </div>
</div>
<!-- /wp:html -->`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  log.info('═══ Portfolio Page Update ═══');

  // Fetch all published apps from the pipeline DB
  log.info('Fetching published apps from pipeline database...');
  const apps = await getPublishedApps();
  log.info(`Found ${apps.length} published apps`);

  if (apps.length === 0) {
    log.warn('No published apps found — skipping portfolio update');
    return;
  }

  for (const app of apps) {
    log.info(`  ${app.app_name} → ${app.wp_page_url} (confidence: ${app.confidence_score})`);
  }

  if (dryRun) {
    log.info('DRY RUN — no changes made');
    return;
  }

  // Generate the portfolio page content
  const content = generatePortfolioContent(apps);

  // Find and update the portfolio page
  const portfolioPage = await findPageBySlug('apps');
  if (!portfolioPage) {
    log.error('Portfolio page (slug: "apps") not found in WordPress!');
    process.exit(1);
  }

  log.info(`Updating portfolio page (ID: ${portfolioPage.id})...`);
  const result = await updatePage(portfolioPage.id, 'Apps & Projects', content, 'publish');
  log.info(`✓ Portfolio updated: ${result.pageUrl}`);
}

main().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
