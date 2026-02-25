#!/usr/bin/env node
/**
 * cost-report.ts
 * ─────────────────────────────────────────────────────────────────────
 * Queries pipeline runs in the last N days and outputs a formatted
 * cost summary.
 *
 * Usage:
 *   npx tsx scripts/cost-report.ts [--days 7] [--json]
 */

import {
  createLogger,
  getConfig,
  getWeeklySpend,
  getMonthlySpend,
  queryRuns,
} from '@appspotlight/shared';

const log = createLogger('cost-report');

function parseArgs(): { days: number; jsonOutput: boolean } {
  const args = process.argv.slice(2);
  let days = 7;
  const daysIdx = args.indexOf('--days');
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    days = parseInt(args[daysIdx + 1], 10);
  }
  const jsonOutput = args.includes('--json');
  return { days, jsonOutput };
}

interface RunSummary {
  run_id: string;
  repo_name: string;
  status: string;
  event_type: string;
  confidence_score: number | null;
  claude_model_used: string;
  claude_cost_usd: number;
  screenshot_cost_usd: number;
  total_cost_usd: number;
  started_at: string;
  completed_at: string | null;
}

async function main(): Promise<void> {
  const { days, jsonOutput } = parseArgs();
  const config = getConfig();

  if (!config.supabase.url) {
    log.error('Database not configured. Set DATABASE_URL in .env');
    process.exit(1);
  }

  const since = new Date();
  since.setDate(since.getDate() - days);

  const runs = await queryRuns(since);
  const typedRuns = runs as unknown as RunSummary[];

  // Calculate aggregates
  const totalRuns = typedRuns.length;
  const completedRuns = typedRuns.filter(r => r.status === 'completed');
  const failedRuns = typedRuns.filter(r => r.status === 'failed');
  const budgetExceeded = typedRuns.filter(r => r.status === 'budget_exceeded');

  const totalCost = typedRuns.reduce((sum, r) => sum + (r.total_cost_usd ?? 0), 0);
  const claudeCost = typedRuns.reduce((sum, r) => sum + (r.claude_cost_usd ?? 0), 0);
  const screenshotCost = typedRuns.reduce((sum, r) => sum + (r.screenshot_cost_usd ?? 0), 0);
  const avgCost = totalRuns > 0 ? totalCost / totalRuns : 0;
  const avgConfidence = completedRuns.length > 0
    ? completedRuns.reduce((sum, r) => sum + (r.confidence_score ?? 0), 0) / completedRuns.length
    : 0;

  // Get budget context
  const weeklySpend = await getWeeklySpend();
  const monthlySpend = await getMonthlySpend();

  if (jsonOutput) {
    const report = {
      period: { days, since: since.toISOString(), until: new Date().toISOString() },
      summary: {
        total_runs: totalRuns,
        completed: completedRuns.length,
        failed: failedRuns.length,
        budget_exceeded: budgetExceeded.length,
      },
      costs: {
        total_cost_usd: Number(totalCost.toFixed(4)),
        claude_cost_usd: Number(claudeCost.toFixed(4)),
        screenshot_cost_usd: Number(screenshotCost.toFixed(4)),
        avg_cost_per_run: Number(avgCost.toFixed(4)),
      },
      budget: {
        weekly_spend: Number(weeklySpend.toFixed(4)),
        weekly_limit: config.budget.maxWeeklyBudget,
        monthly_spend: Number(monthlySpend.toFixed(4)),
        monthly_limit: config.budget.maxMonthlyBudget,
      },
      avg_confidence: Number(avgConfidence.toFixed(1)),
      runs: typedRuns,
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Pretty-print report
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║              AppSpotlight Cost Report                            ║');
  console.log('╠═══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Period:  Last ${days} days (since ${since.toISOString().split('T')[0]})         ║`);
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Run statistics
  console.log('─── Run Statistics ────────────────────────────────────────────────');
  console.log(`  Total Runs:      ${totalRuns}`);
  console.log(`  Completed:       ${completedRuns.length}`);
  console.log(`  Failed:          ${failedRuns.length}`);
  console.log(`  Budget Exceeded: ${budgetExceeded.length}`);
  console.log(`  Avg Confidence:  ${avgConfidence.toFixed(1)}/100`);
  console.log('');

  // Cost breakdown
  console.log('─── Cost Breakdown ───────────────────────────────────────────────');
  console.log(`  Claude API:      $${claudeCost.toFixed(4)}`);
  console.log(`  Screenshots:     $${screenshotCost.toFixed(4)}`);
  console.log(`  Total:           $${totalCost.toFixed(4)}`);
  console.log(`  Avg per Run:     $${avgCost.toFixed(4)}`);
  console.log('');

  // Budget status
  console.log('─── Budget Status ────────────────────────────────────────────────');
  const weeklyPct = config.budget.maxWeeklyBudget > 0
    ? ((weeklySpend / config.budget.maxWeeklyBudget) * 100).toFixed(0)
    : '0';
  const monthlyPct = config.budget.maxMonthlyBudget > 0
    ? ((monthlySpend / config.budget.maxMonthlyBudget) * 100).toFixed(0)
    : '0';

  console.log(`  Weekly:          $${weeklySpend.toFixed(2)} / $${config.budget.maxWeeklyBudget} (${weeklyPct}%)`);
  console.log(`  Monthly:         $${monthlySpend.toFixed(2)} / $${config.budget.maxMonthlyBudget} (${monthlyPct}%)`);
  console.log('');

  // Per-model breakdown
  const modelBreakdown = new Map<string, { count: number; cost: number }>();
  for (const run of typedRuns) {
    const model = run.claude_model_used || 'unknown';
    const existing = modelBreakdown.get(model) ?? { count: 0, cost: 0 };
    existing.count++;
    existing.cost += run.claude_cost_usd ?? 0;
    modelBreakdown.set(model, existing);
  }

  if (modelBreakdown.size > 0) {
    console.log('─── Model Usage ──────────────────────────────────────────────────');
    for (const [model, stats] of modelBreakdown) {
      console.log(`  ${model}: ${stats.count} runs, $${stats.cost.toFixed(4)}`);
    }
    console.log('');
  }

  // Recent runs table
  if (typedRuns.length > 0) {
    console.log('─── Recent Runs ──────────────────────────────────────────────────');
    console.log('  Repo                          Status     Cost      Confidence');
    console.log('  ─────────────────────────────────────────────────────────────');
    for (const run of typedRuns.slice(0, 20)) {
      const repo = run.repo_name.padEnd(30).substring(0, 30);
      const status = run.status.padEnd(10);
      const cost = `$${(run.total_cost_usd ?? 0).toFixed(4)}`.padEnd(10);
      const conf = run.confidence_score !== null ? `${run.confidence_score}/100` : '—';
      console.log(`  ${repo} ${status} ${cost} ${conf}`);
    }
    if (typedRuns.length > 20) {
      console.log(`  ... and ${typedRuns.length - 20} more`);
    }
    console.log('');
  }
}

main().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
