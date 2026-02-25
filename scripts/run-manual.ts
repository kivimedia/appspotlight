#!/usr/bin/env node
/**
 * run-manual.ts
 * ─────────────────────────────────────────────────────────────────────
 * Manual trigger for the AppSpotlight pipeline.
 * Accepts a GitHub repo URL, runs Analyst + Publisher, and logs to Supabase.
 *
 * Usage:
 *   npx tsx scripts/run-manual.ts <repo-url> [--deployed-url <url>] [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/run-manual.ts https://github.com/ZivRaviv/choirmind
 *   npx tsx scripts/run-manual.ts https://github.com/ZivRaviv/choirmind --deployed-url https://choirmind.app
 *   npx tsx scripts/run-manual.ts https://github.com/ZivRaviv/choirmind --dry-run
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
import { publishApp } from '@appspotlight/publisher';

const log = createLogger('manual');

// ─── CLI Arg Parsing ───────────────────────────────────────────────────────

function parseArgs(): { repoUrl: string; deployedUrl?: string; dryRun: boolean } {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
AppSpotlight Manual Pipeline Runner
════════════════════════════════════

Usage:
  npx tsx scripts/run-manual.ts <repo-url> [options]

Options:
  --deployed-url <url>   Override the deployed URL (skip auto-detection)
  --dry-run              Run analyst only, skip publishing to WordPress
  --help, -h             Show this help message

Examples:
  npx tsx scripts/run-manual.ts https://github.com/ZivRaviv/choirmind
  npx tsx scripts/run-manual.ts https://github.com/ZivRaviv/choirmind --deployed-url https://choirmind.app
  npx tsx scripts/run-manual.ts https://github.com/ZivRaviv/choirmind --dry-run
`);
    process.exit(0);
  }

  const repoUrl = args[0];

  // Validate URL
  if (!repoUrl.includes('github.com/')) {
    log.error('Invalid repo URL. Must be a GitHub repository URL.');
    process.exit(1);
  }

  let deployedUrl: string | undefined;
  const deployedIdx = args.indexOf('--deployed-url');
  if (deployedIdx !== -1 && args[deployedIdx + 1]) {
    deployedUrl = args[deployedIdx + 1];
  }

  const dryRun = args.includes('--dry-run');

  return { repoUrl, deployedUrl, dryRun };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { repoUrl, deployedUrl, dryRun } = parseArgs();
  const runId = randomUUID();

  // Extract repo name from URL
  const repoName = repoUrl
    .replace(/\.git$/, '')
    .split('/')
    .slice(-2)
    .join('/');

  log.info('═══════════════════════════════════════════════════════');
  log.info(`  AppSpotlight Manual Run`);
  log.info(`  Repo:    ${repoName}`);
  log.info(`  URL:     ${repoUrl}`);
  log.info(`  Run ID:  ${runId}`);
  if (deployedUrl) log.info(`  Deploy:  ${deployedUrl}`);
  if (dryRun) log.info(`  Mode:    DRY RUN (analyst only)`);
  log.info('═══════════════════════════════════════════════════════');

  // Create run record in Supabase
  await createRunRecord(runId, repoName, 'manual');

  // Check budget
  const budgetCheck = await checkBudget();
  if (!budgetCheck.allowed) {
    log.error(`Budget exceeded: ${budgetCheck.reason}`);
    await failRunRecord(runId, `Budget exceeded: ${budgetCheck.reason}`);
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    // ── Step 1: Analyst ──
    log.info('');
    log.info('Phase 1: ANALYST');
    log.info('─────────────────────────────────────────');

    const analystOutput = await analyzeRepo({
      repoUrl,
      deployedUrl: deployedUrl ?? null,
    });

    log.info('');
    log.info('Analyst Summary:');
    log.info(`  App Name:    ${analystOutput.content.app_name}`);
    log.info(`  Tagline:     ${analystOutput.content.tagline}`);
    log.info(`  Features:    ${analystOutput.content.features.length}`);
    log.info(`  Screenshots: ${analystOutput.screenshots.length}`);
    log.info(`  Confidence:  ${analystOutput.confidence}/100`);
    log.info(`  Cost:        $${analystOutput.costData.total_cost_usd.toFixed(4)}`);
    log.info(`  Model:       ${analystOutput.costData.claude_model_used}`);
    log.info('');

    if (dryRun) {
      log.info('DRY RUN — skipping Publisher');
      log.info('');
      log.info('Generated Content Preview:');
      log.info(`  Problem:     ${analystOutput.content.problem_statement.substring(0, 100)}...`);
      log.info(`  Audience:    ${analystOutput.content.target_audience}`);
      log.info(`  Tech Stack:  ${analystOutput.content.tech_stack.join(', ')}`);
      log.info(`  CTA URL:     ${analystOutput.content.cta_url}`);

      // Still log the run as completed (dry run)
      await completeRunRecord(
        runId,
        analystOutput.costData,
        null,
        analystOutput.confidence,
        { passed: true, failures: [] }
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log.info('');
      log.info(`✓ Dry run completed in ${elapsed}s`);
      return;
    }

    // ── Step 2: Publisher ──
    log.info('Phase 2: PUBLISHER');
    log.info('─────────────────────────────────────────');

    const publishResult = await publishApp(analystOutput);

    // Log to Supabase
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

    log.info('');
    log.info('═══════════════════════════════════════════════════════');
    log.info(`  Pipeline Complete!`);
    log.info(`  Page:    ${publishResult.pageResult.pageUrl}`);
    log.info(`  Status:  ${publishResult.pageResult.status}`);
    log.info(`  Action:  ${publishResult.pageResult.action}`);
    log.info(`  QA:      ${publishResult.qaResult.passed ? 'PASSED' : 'FAILED'}`);
    if (publishResult.qaResult.failures.length > 0) {
      log.info(`  Issues:  ${publishResult.qaResult.failures.join(', ')}`);
    }
    log.info(`  Time:    ${elapsed}s`);
    log.info(`  Cost:    $${analystOutput.costData.total_cost_usd.toFixed(4)}`);
    log.info('═══════════════════════════════════════════════════════');
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const message = (err as Error).message;

    log.error(`Pipeline failed after ${elapsed}s: ${message}`);
    await failRunRecord(runId, message);
    process.exit(1);
  }
}

main().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
