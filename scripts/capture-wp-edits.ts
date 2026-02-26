#!/usr/bin/env node
/**
 * capture-wp-edits.ts
 * ─────────────────────────────────────────────────────────────────────
 * Captures human edits made to WordPress pages by diffing current WP content
 * against the stored generated_content in the database.
 *
 * Usage:
 *   npx tsx scripts/capture-wp-edits.ts [--dry-run]
 */

import {
  createLogger,
  getRunByWpPageId,
  updateRunRecord,
} from '@appspotlight/shared';
import type { AppContent, HumanEdit } from '@appspotlight/shared';
import { fetchChildPages } from '@appspotlight/publisher';

const log = createLogger('capture-edits');

// ─── HTML Content Extraction ────────────────────────────────────────────────

function extractFromHtml(html: string): Partial<AppContent> {
  const result: Partial<AppContent> = {};

  // app_name: <h1> in the hero cover block
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (h1Match) result.app_name = decodeEntities(h1Match[1].trim());

  // tagline: first <p> in the hero cover (has cyan-bluish-gray color, font-size:1.3rem)
  const taglineMatch = html.match(/font-size:1\.3rem[^"]*"[^>]*>([^<]+)<\/p>/);
  if (taglineMatch) result.tagline = decodeEntities(taglineMatch[1].trim());

  // problem_statement: text from the problem/solution section
  // "The Problem" label followed by a paragraph
  const problemMatch = html.match(/The Problem<\/p>[\s\S]*?<p[^>]*>([^<]+)<\/p>/);
  const solutionMatch = html.match(/The Solution<\/p>[\s\S]*?<p[^>]*>([^<]+)<\/p>/);
  if (problemMatch && solutionMatch) {
    result.problem_statement = `${decodeEntities(problemMatch[1].trim())} ${decodeEntities(solutionMatch[1].trim())}`;
  } else if (problemMatch) {
    result.problem_statement = decodeEntities(problemMatch[1].trim());
  }

  // features: <h3> + <p> pairs in feature card columns
  const featureRegex = /<h3[^>]*>([^<]+)<\/h3>\s*[\s\S]*?<p[^>]*style="font-size:0\.95rem"[^>]*>([^<]+)<\/p>/g;
  const features: AppContent['features'] = [];
  let featureMatch;
  while ((featureMatch = featureRegex.exec(html)) !== null) {
    features.push({
      title: decodeEntities(featureMatch[1].trim()),
      description: decodeEntities(featureMatch[2].trim()),
    });
  }
  if (features.length > 0) result.features = features;

  // tech_stack: <span> elements in the tech stack section
  const techSection = html.match(/appspotlight-tech-stack[\s\S]*?<\/div>\s*<!-- \/wp:html -->/);
  if (techSection) {
    const techRegex = /<span[^>]*>([^<]+)<\/span>/g;
    const techStack: string[] = [];
    let techMatch;
    while ((techMatch = techRegex.exec(techSection[0])) !== null) {
      techStack.push(decodeEntities(techMatch[1].trim()));
    }
    if (techStack.length > 0) result.tech_stack = techStack;
  }

  // target_audience: <p> text in audience section cards
  const audienceSection = html.match(/appspotlight-audience[\s\S]*?<!-- \/wp:group -->/);
  if (audienceSection) {
    const audienceRegex = /has-text-align-center"[^>]*>([^<]+)<\/p>\s*<\/div>/g;
    const audiences: string[] = [];
    let audienceMatch;
    while ((audienceMatch = audienceRegex.exec(audienceSection[0])) !== null) {
      // Skip emoji-only paragraphs
      const text = decodeEntities(audienceMatch[1].trim());
      if (text.length > 3) audiences.push(text);
    }
    if (audiences.length > 0) result.target_audience = audiences.join(', ');
  }

  // cta_text + cta_url: button in hero section
  const ctaMatch = html.match(/<a[^>]*class="wp-block-button__link[^"]*"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/);
  if (ctaMatch) {
    result.cta_url = decodeEntities(ctaMatch[1]);
    result.cta_text = decodeEntities(ctaMatch[2].trim());
  }

  return result;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

// ─── Diff Logic ─────────────────────────────────────────────────────────────

function diffContent(
  original: AppContent,
  current: Partial<AppContent>
): HumanEdit[] {
  const edits: HumanEdit[] = [];
  const fieldsToCheck: (keyof AppContent)[] = [
    'app_name', 'tagline', 'problem_statement', 'target_audience',
    'cta_text', 'cta_url',
  ];

  for (const field of fieldsToCheck) {
    const origVal = original[field];
    const currVal = current[field];
    if (currVal && typeof origVal === 'string' && typeof currVal === 'string') {
      if (normalize(origVal) !== normalize(currVal)) {
        edits.push({
          field,
          original_value: origVal,
          edited_value: currVal,
          detected_at: new Date().toISOString(),
        });
      }
    }
  }

  // Check features (compare by count and titles)
  if (current.features && original.features) {
    const origTitles = original.features.map(f => normalize(f.title)).sort().join('|');
    const currTitles = current.features.map(f => normalize(f.title)).sort().join('|');
    if (origTitles !== currTitles) {
      edits.push({
        field: 'features',
        original_value: JSON.stringify(original.features),
        edited_value: JSON.stringify(current.features),
        detected_at: new Date().toISOString(),
      });
    }
  }

  // Check tech_stack
  if (current.tech_stack && original.tech_stack) {
    const origStack = original.tech_stack.slice().sort().join('|');
    const currStack = current.tech_stack.slice().sort().join('|');
    if (origStack !== currStack) {
      edits.push({
        field: 'tech_stack',
        original_value: JSON.stringify(original.tech_stack),
        edited_value: JSON.stringify(current.tech_stack),
        detected_at: new Date().toISOString(),
      });
    }
  }

  return edits;
}

function normalize(str: string): string {
  return str.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  log.info('═══════════════════════════════════════════════════════');
  log.info('  AppSpotlight — WordPress Edit Capture');
  if (dryRun) log.info('  Mode: DRY RUN');
  log.info('═══════════════════════════════════════════════════════');
  log.info('');

  // Fetch all child pages under /apps
  log.info('Fetching WordPress app pages...');
  const pages = await fetchChildPages('apps');
  log.info(`Found ${pages.length} app pages`);

  let totalEdits = 0;
  let pagesWithEdits = 0;

  for (const page of pages) {
    // Look up the matching pipeline run by WP page ID
    const run = await getRunByWpPageId(page.id);
    if (!run) {
      log.info(`  ${page.title} (ID: ${page.id}) — no matching run, skipping`);
      continue;
    }

    if (!run.generated_content) {
      log.info(`  ${page.title} (ID: ${page.id}) — no stored content, skipping`);
      continue;
    }

    // Extract current content from WordPress HTML
    const currentContent = extractFromHtml(page.content);

    // Diff against stored generated content
    const edits = diffContent(run.generated_content, currentContent);

    if (edits.length === 0) {
      log.info(`  ${page.title} — no edits detected`);
      continue;
    }

    pagesWithEdits++;
    totalEdits += edits.length;

    log.info(`  ${page.title} — ${edits.length} edit(s) detected:`);
    for (const edit of edits) {
      log.info(`    • ${edit.field}: "${truncate(edit.original_value, 40)}" → "${truncate(edit.edited_value, 40)}"`);
    }

    if (!dryRun) {
      // Merge with existing human_edits if any
      const existingEdits = run.human_edits ?? [];
      const allEdits = [...existingEdits, ...edits];
      await updateRunRecord(run.run_id, {
        human_edits: allEdits,
        publish_action: 'draft_edited',
      });
      log.info(`    → Saved ${edits.length} edits to DB`);
    }
  }

  log.info('');
  log.info('═══════════════════════════════════════════════════════');
  log.info(`  Done! ${pagesWithEdits} page(s) with ${totalEdits} total edit(s)`);
  log.info('═══════════════════════════════════════════════════════');
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

main().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
