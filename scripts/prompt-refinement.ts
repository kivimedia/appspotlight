#!/usr/bin/env node
/**
 * prompt-refinement.ts
 * ─────────────────────────────────────────────────────────────────────
 * Aggregates human edits and QA failures from pipeline runs to suggest
 * prompt improvements for the Analyst's content generation.
 *
 * Usage:
 *   npx tsx scripts/prompt-refinement.ts [--days <n>]
 */

import {
  createLogger,
  getRunsWithEdits,
} from '@appspotlight/shared';
import type { HumanEdit } from '@appspotlight/shared';

const log = createLogger('refinement');

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg !== -1 && process.argv[daysArg + 1]
    ? parseInt(process.argv[daysArg + 1], 10)
    : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);

  log.info('');
  log.info('═══ Prompt Refinement Report ═══');
  log.info(`Period: Last ${days} days (since ${since.toISOString().split('T')[0]})`);
  log.info('');

  const runs = await getRunsWithEdits(since);

  if (runs.length === 0) {
    log.info('No runs with edits or QA failures found in this period.');
    return;
  }

  log.info(`${runs.length} run(s) analyzed`);
  log.info('');

  // ─── Aggregate Human Edits by Field ─────────────────────────────────────

  const editsByField = new Map<string, { count: number; examples: Array<{ repo: string; original: string; edited: string }> }>();

  for (const run of runs) {
    const edits = (run.human_edits ?? []) as HumanEdit[];
    for (const edit of edits) {
      const entry = editsByField.get(edit.field) ?? { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 3) {
        entry.examples.push({
          repo: run.repo_name,
          original: edit.original_value,
          edited: edit.edited_value,
        });
      }
      editsByField.set(edit.field, entry);
    }
  }

  // ─── Aggregate QA Failures ──────────────────────────────────────────────

  const failuresByType = new Map<string, number>();

  for (const run of runs) {
    for (const failure of run.auto_check_failures) {
      failuresByType.set(failure, (failuresByType.get(failure) ?? 0) + 1);
    }
  }

  // ─── Report: Most Edited Fields ──────────────────────────────────────────

  const sortedEdits = [...editsByField.entries()].sort((a, b) => b[1].count - a[1].count);

  if (sortedEdits.length > 0) {
    log.info('─── Most Edited Fields ─────────────────────────────');
    for (const [field, data] of sortedEdits) {
      log.info(`  ${data.count}x  ${field}`);
      for (const ex of data.examples) {
        log.info(`      ${ex.repo}: "${truncate(ex.original, 50)}" → "${truncate(ex.edited, 50)}"`);
      }
    }
    log.info('');
  }

  // ─── Report: Most Common QA Failures ─────────────────────────────────────

  const sortedFailures = [...failuresByType.entries()].sort((a, b) => b[1] - a[1]);

  if (sortedFailures.length > 0) {
    log.info('─── Most Common QA Failures ────────────────────────');
    for (const [failure, count] of sortedFailures) {
      log.info(`  ${count}x  ${failure}`);
    }
    log.info('');
  }

  // ─── Suggested Prompt Additions ───────────────────────────────────────────

  log.info('─── Suggested Prompt Additions ─────────────────────');

  const suggestions: string[] = [];

  // Suggestions based on edited fields
  for (const [field, data] of sortedEdits) {
    if (data.count >= 2) {
      switch (field) {
        case 'tagline':
          suggestions.push(`Tagline edited ${data.count} times → make taglines shorter and punchier (under 8 words)`);
          break;
        case 'problem_statement':
          suggestions.push(`Problem statement edited ${data.count} times → be more specific about pain points, use concrete examples`);
          break;
        case 'target_audience':
          suggestions.push(`Target audience edited ${data.count} times → identify specific user personas, not generic groups`);
          break;
        case 'features':
          suggestions.push(`Features edited ${data.count} times → extract concrete features from actual code, not generic capabilities`);
          break;
        case 'app_name':
          suggestions.push(`App name edited ${data.count} times → use the exact repo name or a clearly branded name from README`);
          break;
        case 'cta_text':
          suggestions.push(`CTA text edited ${data.count} times → use action-oriented button text (Try It, See Demo, View Docs)`);
          break;
        default:
          suggestions.push(`${field} edited ${data.count} times → review how this field is generated`);
      }
    }
  }

  // Suggestions based on QA failures
  for (const [failure, count] of sortedFailures) {
    if (count >= 2) {
      if (failure.includes('features')) {
        suggestions.push(`"${failure}" failed ${count} times → always identify at least 3 concrete features from the code`);
      } else if (failure.includes('audience')) {
        suggestions.push(`"${failure}" failed ${count} times → always provide a meaningful target audience description (>10 words)`);
      } else if (failure.includes('screenshot')) {
        suggestions.push(`"${failure}" failed ${count} times → consider fallback screenshot strategies for apps without deployed URLs`);
      } else if (failure.includes('problem')) {
        suggestions.push(`"${failure}" failed ${count} times → ensure problem statement is 2-3 full sentences (30-150 words)`);
      } else if (failure.includes('tagline')) {
        suggestions.push(`"${failure}" failed ${count} times → keep taglines concise, under 12 words`);
      } else {
        suggestions.push(`"${failure}" failed ${count} times → review the ${failure} check requirements`);
      }
    }
  }

  if (suggestions.length === 0) {
    log.info('  No patterns strong enough to suggest changes yet.');
    log.info('  Accumulate more runs before refining prompts.');
  } else {
    for (let i = 0; i < suggestions.length; i++) {
      log.info(`  ${i + 1}. ${suggestions[i]}`);
    }
  }

  log.info('');
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
