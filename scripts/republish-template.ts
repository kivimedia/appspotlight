#!/usr/bin/env npx tsx
/**
 * republish-template.ts
 *
 * Re-renders all published app pages using the CURRENT page template,
 * without re-running AI analysis. Pulls stored content from the DB,
 * extracts existing screenshots from WordPress pages, and pushes
 * regenerated markup back to WordPress.
 *
 * Usage:
 *   npx tsx scripts/republish-template.ts            # republish all
 *   npx tsx scripts/republish-template.ts --dry-run   # preview only
 */

import {
  createLogger,
  getConfig,
  getDbPool,
  getProjectType,
} from '@appspotlight/shared';
import type { AppContent, WPMediaResult, ProjectType } from '@appspotlight/shared';
import { generatePageMarkup, updatePage } from '@appspotlight/publisher';

const log = createLogger('republish');

interface PublishedApp {
  repo_name: string;
  wp_page_id: number;
  wp_page_url: string;
  app_name: string;
  confidence_score: number;
  generated_content: AppContent;
}

// ─── Extract existing media from a WP page ────────────────────────────────

async function getPageMedia(pageId: number): Promise<WPMediaResult[]> {
  const config = getConfig();
  const auth = Buffer.from(
    `${config.wordpress.username}:${config.wordpress.appPassword}`,
  ).toString('base64');

  try {
    const resp = await fetch(
      `${config.wordpress.baseUrl}/wp-json/wp/v2/pages/${pageId}?_fields=content`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!resp.ok) return [];

    const page = (await resp.json()) as { content: { rendered: string } };
    const html = page.content.rendered;

    // Extract wp-image-{id} class + src from <img> tags
    const results: WPMediaResult[] = [];
    const imgRegex = /<img[^>]+class="[^"]*wp-image-(\d+)[^"]*"[^>]+src="([^"]+)"/g;
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      results.push({
        mediaId: parseInt(match[1], 10),
        sourceUrl: match[2],
      });
    }

    // Also try src before class order
    const imgRegex2 = /<img[^>]+src="([^"]+)"[^>]+class="[^"]*wp-image-(\d+)[^"]*"/g;
    while ((match = imgRegex2.exec(html)) !== null) {
      const id = parseInt(match[2], 10);
      if (!results.some((r) => r.mediaId === id)) {
        results.push({ mediaId: id, sourceUrl: match[1] });
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  log.info(`═══ Republish All App Pages (template-only) ═══`);
  if (dryRun) log.info('DRY RUN — no pages will be updated');

  const pool = getDbPool();
  if (!pool) {
    log.error('No database connection. Set DATABASE_URL.');
    process.exit(1);
  }

  // Fetch all published apps with their stored content
  const result = await pool.query<PublishedApp>(`
    SELECT DISTINCT ON (normalized_name)
      REPLACE(repo_name, 'kivimedia/', '') as repo_name,
      wp_page_id,
      wp_page_url,
      confidence_score,
      COALESCE(generated_content->>'app_name', REPLACE(repo_name, 'kivimedia/', '')) as app_name,
      generated_content
    FROM (
      SELECT *, REPLACE(repo_name, 'kivimedia/', '') as normalized_name
      FROM pipeline_runs
      WHERE status = 'completed'
        AND wp_page_url IS NOT NULL
        AND wp_page_id IS NOT NULL
        AND generated_content IS NOT NULL
        AND publish_action IN ('auto_published', 'draft_approved', 'draft_edited')
    ) sub
    ORDER BY normalized_name, completed_at DESC
  `);

  const apps = result.rows;
  log.info(`Found ${apps.length} published apps to republish`);

  let succeeded = 0;
  let failed = 0;

  for (const app of apps) {
    const i = apps.indexOf(app) + 1;
    log.info(`[${i}/${apps.length}] ${app.app_name} (page ${app.wp_page_id})...`);

    try {
      // Get existing screenshots from the page
      const media = await getPageMedia(app.wp_page_id);
      log.info(`  Found ${media.length} existing screenshots`);

      // Determine project type from config
      const projectType: ProjectType = getProjectType(app.repo_name);
      const repoUrl = `https://github.com/kivimedia/${app.repo_name}`;

      // Regenerate markup with updated template
      const markup = generatePageMarkup(
        app.generated_content,
        media,
        app.repo_name,
        app.confidence_score ?? 50,
        repoUrl,
        projectType,
      );

      if (dryRun) {
        log.info(`  [DRY RUN] Would update page ${app.wp_page_id} (${markup.length} chars)`);
      } else {
        await updatePage(app.wp_page_id, app.app_name, markup, 'publish');
        log.info(`  ✓ Updated: ${app.wp_page_url}`);
      }

      succeeded++;
    } catch (err) {
      failed++;
      log.error(`  ✗ Failed: ${err instanceof Error ? err.message : err}`);
    }

    // Small delay to avoid rate-limiting
    if (!dryRun && i < apps.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  await pool.end();

  log.info('');
  log.info(`═══ Summary ═══`);
  log.info(`  Total:     ${apps.length}`);
  log.info(`  Succeeded: ${succeeded}`);
  log.info(`  Failed:    ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
