#!/usr/bin/env node
/**
 * backfill.ts
 * ─────────────────────────────────────────────────────────────────────
 * Runs the AppSpotlight pipeline on all existing repos for a GitHub user/org.
 * Fetches the repo list via GitHub API, filters by config exclusions,
 * and processes each one sequentially with cooldowns.
 *
 * Usage:
 *   npx tsx scripts/backfill.ts <github-owner> [options]
 *
 * Options:
 *   --max <n>          Max repos to process (default: all)
 *   --delay <ms>       Delay between repos in ms (default: 5000)
 *   --dry-run          List repos without processing
 *   --skip-existing    Skip repos that already have a WordPress page
 *   --include <repos>  Comma-separated list of specific repos to include
 */

import { randomUUID } from 'crypto';
import {
  createLogger,
  getConfig,
  createRunRecord,
  completeRunRecord,
  failRunRecord,
  checkBudget,
} from '@appspotlight/shared';
import { analyzeRepo } from '@appspotlight/analyst';
import { publishApp, findPageBySlug } from '@appspotlight/publisher';

const log = createLogger('backfill');

// ─── Types ─────────────────────────────────────────────────────────────────

interface GitHubRepo {
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  homepage: string | null;
  description: string | null;
  fork: boolean;
  archived: boolean;
  private: boolean;
  language: string | null;
  size: number;
  pushed_at: string;
}

interface BackfillOptions {
  owner: string;
  maxRepos: number;
  delayMs: number;
  dryRun: boolean;
  skipExisting: boolean;
  includeOnly: string[];
}

// ─── CLI Arg Parsing ───────────────────────────────────────────────────────

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
AppSpotlight Backfill — Process All Repos
══════════════════════════════════════════

Usage:
  npx tsx scripts/backfill.ts <github-owner> [options]

Options:
  --max <n>              Max repos to process (default: all)
  --delay <ms>           Delay between repos in ms (default: 5000)
  --dry-run              List repos without processing
  --skip-existing        Skip repos that already have a WordPress page
  --include <repos>      Comma-separated list of specific repos to include
  --help, -h             Show this help message

Examples:
  npx tsx scripts/backfill.ts ZivRaviv --dry-run
  npx tsx scripts/backfill.ts ZivRaviv --max 5 --skip-existing
  npx tsx scripts/backfill.ts ZivRaviv --include choirmind,my-app
`);
    process.exit(0);
  }

  const owner = args[0];
  let maxRepos = Infinity;
  let delayMs = 5000;
  let dryRun = false;
  let skipExisting = false;
  let includeOnly: string[] = [];

  const maxIdx = args.indexOf('--max');
  if (maxIdx !== -1 && args[maxIdx + 1]) maxRepos = parseInt(args[maxIdx + 1], 10);

  const delayIdx = args.indexOf('--delay');
  if (delayIdx !== -1 && args[delayIdx + 1]) delayMs = parseInt(args[delayIdx + 1], 10);

  dryRun = args.includes('--dry-run');
  skipExisting = args.includes('--skip-existing');

  const includeIdx = args.indexOf('--include');
  if (includeIdx !== -1 && args[includeIdx + 1]) {
    includeOnly = args[includeIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
  }

  return { owner, maxRepos, delayMs, dryRun, skipExisting, includeOnly };
}

// ─── GitHub API ────────────────────────────────────────────────────────────

async function fetchRepos(owner: string, token: string): Promise<GitHubRepo[]> {
  const allRepos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `https://api.github.com/users/${owner}/repos?per_page=${perPage}&page=${page}&sort=pushed&direction=desc`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const repos = (await response.json()) as GitHubRepo[];
    if (repos.length === 0) break;

    allRepos.push(...repos);
    if (repos.length < perPage) break;
    page++;
  }

  return allRepos;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = getConfig();

  log.info('═══════════════════════════════════════════════════════');
  log.info(`  AppSpotlight Backfill`);
  log.info(`  Owner: ${opts.owner}`);
  if (opts.dryRun) log.info('  Mode: DRY RUN');
  log.info('═══════════════════════════════════════════════════════');
  log.info('');

  // Fetch all repos
  log.info('Fetching repos from GitHub...');
  const allRepos = await fetchRepos(opts.owner, config.github.token);
  log.info(`Found ${allRepos.length} total repos`);

  // Filter repos
  let repos = allRepos.filter(r => {
    // Skip forks and archived repos
    if (r.fork || r.archived) return false;
    // Skip excluded repos
    if (config.github.excludedRepos.includes(r.name)) return false;
    // Skip empty repos (< 1KB)
    if (r.size < 1) return false;
    // If include list specified, filter to those
    if (opts.includeOnly.length > 0 && !opts.includeOnly.includes(r.name)) return false;
    return true;
  });

  log.info(`${repos.length} repos after filtering (excluded: forks, archived, empty, config exclusions)`);

  // Apply max limit
  if (repos.length > opts.maxRepos) {
    repos = repos.slice(0, opts.maxRepos);
    log.info(`Limited to ${opts.maxRepos} repos`);
  }

  // Dry run: just list
  if (opts.dryRun) {
    log.info('');
    log.info('─── Repos to Process ─────────────────────────────────────────────');
    for (const repo of repos) {
      const lang = repo.language ?? 'unknown';
      const homepage = repo.homepage ? ` → ${repo.homepage}` : '';
      log.info(`  ${repo.full_name} (${lang}, ${repo.size}KB)${homepage}`);
    }
    log.info('');
    log.info(`Total: ${repos.length} repos`);
    return;
  }

  // Process each repo
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const runId = randomUUID();
    const slug = repo.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    log.info('');
    log.info(`[${i + 1}/${repos.length}] ${repo.full_name}`);
    log.info('─────────────────────────────────────────');

    // Skip existing pages if requested
    if (opts.skipExisting) {
      try {
        const existing = await findPageBySlug(slug);
        if (existing) {
          log.info(`  Skipped — page already exists (ID: ${existing.id})`);
          skipped++;
          continue;
        }
      } catch {
        // If WP lookup fails, proceed anyway
      }
    }

    // Check budget before each run
    const budgetCheck = await checkBudget();
    if (!budgetCheck.allowed) {
      log.warn(`Budget exceeded: ${budgetCheck.reason}`);
      log.warn(`Stopping backfill at repo ${i + 1}/${repos.length}`);
      break;
    }

    processed++;
    await createRunRecord(runId, repo.full_name, 'manual');

    try {
      const startTime = Date.now();

      // Analyst
      const analystOutput = await analyzeRepo({
        repoUrl: repo.clone_url,
        deployedUrl: repo.homepage,
      });

      // Publisher
      const publishResult = await publishApp(analystOutput);

      // Log completion
      await completeRunRecord(
        runId,
        analystOutput.costData,
        {
          pageId: publishResult.pageResult.pageId,
          pageUrl: publishResult.pageResult.pageUrl,
          status: publishResult.pageResult.status,
        },
        analystOutput.confidence,
        publishResult.qaResult
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log.info(`  ✓ Done in ${elapsed}s → ${publishResult.pageResult.pageUrl} (${publishResult.pageResult.status})`);
      succeeded++;
    } catch (err) {
      const message = (err as Error).message;
      log.error(`  ✗ Failed: ${message}`);
      await failRunRecord(runId, message);
      failed++;
    }

    // Delay between repos (don't delay after last one)
    if (i < repos.length - 1 && opts.delayMs > 0) {
      log.info(`  Waiting ${opts.delayMs / 1000}s before next repo...`);
      await new Promise(resolve => setTimeout(resolve, opts.delayMs));
    }
  }

  // Summary
  log.info('');
  log.info('═══════════════════════════════════════════════════════');
  log.info(`  Backfill Complete`);
  log.info(`  Processed: ${processed}`);
  log.info(`  Succeeded: ${succeeded}`);
  log.info(`  Failed:    ${failed}`);
  log.info(`  Skipped:   ${skipped}`);
  log.info('═══════════════════════════════════════════════════════');
}

main().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
