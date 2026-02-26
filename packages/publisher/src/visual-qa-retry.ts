import { createLogger, getConfig, updateRunRecord } from '@appspotlight/shared';
import type { AnalystOutput, VisualQAResult, VisualQAIssue } from '@appspotlight/shared';
import type { PublishResult } from './index.js';
import { runVisualQA } from './visual-qa.js';
import { publishDraftPage, revertToDraft } from './wordpress-client.js';

const log = createLogger('vqa-retry');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VQARetryOptions {
  runId: string;
  repoUrl: string;
  analystOutput: AnalystOutput;
  publishResult: PublishResult;
  // Injected to avoid circular imports (publishApp lives in ./index.ts which re-exports us)
  publishApp: (output: AnalystOutput) => Promise<PublishResult>;
  regenerateContent: (repoUrl: string, prev: AnalystOutput, failures: string[]) => Promise<AnalystOutput>;
}

export interface VQARetryResult {
  visualQAResult: VisualQAResult | undefined;
  analystOutput: AnalystOutput;
  publishResult: PublishResult;
  retryCount: number;
  totalRetryCost: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Filter VQA issues to only those fixable by content regeneration. */
function getRetryableIssues(issues: VisualQAIssue[], retryableCategories: string[]): VisualQAIssue[] {
  return issues.filter(
    issue => issue.severity !== 'info' && retryableCategories.includes(issue.category)
  );
}

/** Convert VQA issues into feedback strings for regenerateContent(). */
function vqaIssuesToFeedback(issues: VisualQAIssue[]): string[] {
  return issues.map(
    issue => `[Visual QA ${issue.severity}] [${issue.category}] ${issue.description}`
  );
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run Visual QA with optional retry loop.
 * If VQA fails on content-fixable issues, regenerates content, re-publishes,
 * and re-runs VQA up to maxRetries times.
 */
export async function runVisualQAWithRetry(opts: VQARetryOptions): Promise<VQARetryResult> {
  const config = getConfig();
  let { analystOutput, publishResult } = opts;
  const { runId, repoUrl, publishApp, regenerateContent } = opts;

  let visualQAResult: VisualQAResult | undefined;
  let retryCount = 0;
  let totalRetryCost = 0;

  // Skip if VQA disabled or no page URL
  if (!config.visualQA.enabled || !publishResult.pageResult.pageUrl) {
    return { visualQAResult, analystOutput, publishResult, retryCount, totalRetryCost };
  }

  const maxAttempts = 1 + (config.visualQA.retryEnabled ? config.visualQA.maxRetries : 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isRetry = attempt > 1;
    log.info(isRetry
      ? `Visual QA retry ${attempt - 1}/${config.visualQA.maxRetries}...`
      : 'Running Visual QA...'
    );

    // Draft/publish dance: temporarily publish if draft so we can screenshot
    let wasPublishedForQA = false;
    if (publishResult.pageResult.status === 'draft') {
      log.info('Temporarily publishing draft for visual QA screenshot...');
      await publishDraftPage(publishResult.pageResult.pageId);
      wasPublishedForQA = true;
    }

    try {
      visualQAResult = await runVisualQA(
        publishResult.pageResult.pageUrl,
        analystOutput.content,
        publishResult.mediaResults.length
      );

      if (visualQAResult.passed) {
        log.info(isRetry ? 'Visual QA PASSED after retry' : 'Visual QA PASSED');
        // If we published just for QA and programmatic QA had failed, revert
        if (wasPublishedForQA && !publishResult.qaResult.passed) {
          log.info('Reverting to draft (programmatic QA had failed)...');
          await revertToDraft(publishResult.pageResult.pageId);
          publishResult.pageResult.status = 'draft';
        }
        break; // Success
      }

      // VQA failed — log issues
      log.warn(`Visual QA FAILED: ${visualQAResult.issues.length} issues`);
      for (const issue of visualQAResult.issues) {
        log.warn(`  [${issue.severity}] [${issue.category}] ${issue.description}`);
      }

      // Check if we should retry
      const retryableIssues = getRetryableIssues(
        visualQAResult.issues,
        config.visualQA.retryableCategories
      );

      const canRetry = config.visualQA.retryEnabled
        && attempt < maxAttempts
        && retryableIssues.length > 0
        && analystOutput.confidence >= 40;

      if (canRetry) {
        log.info(`${retryableIssues.length} retryable issue(s) — regenerating content...`);
        const feedback = vqaIssuesToFeedback(retryableIssues);

        try {
          // Revert to draft before regeneration
          if (publishResult.pageResult.status === 'publish' || wasPublishedForQA) {
            await revertToDraft(publishResult.pageResult.pageId);
            publishResult.pageResult.status = 'draft';
          }

          // Regenerate content with VQA feedback
          const retryOutput = await regenerateContent(repoUrl, analystOutput, feedback);

          // Re-publish with improved content (updates existing WP page)
          const retryPublishResult = await publishApp(retryOutput);

          // Track costs
          totalRetryCost += retryOutput.costData.total_cost_usd + visualQAResult.costData.cost_usd;
          retryCount++;

          // Use updated outputs for next iteration
          analystOutput = retryOutput;
          publishResult = retryPublishResult;

          continue; // Next attempt will re-run VQA
        } catch (retryErr) {
          log.error(`VQA retry failed: ${(retryErr as Error).message}`);
          // Fall through to revert below
        }
      }

      // No retry possible — revert to draft
      if (publishResult.pageResult.status === 'publish' || wasPublishedForQA) {
        log.info('Reverting page to draft due to visual QA failure...');
        await revertToDraft(publishResult.pageResult.pageId);
        publishResult.pageResult.status = 'draft';
      }
      break;

    } catch (vqaErr) {
      log.error(`Visual QA error: ${(vqaErr as Error).message}`);
      if (wasPublishedForQA) {
        await revertToDraft(publishResult.pageResult.pageId);
        publishResult.pageResult.status = 'draft';
      }
      break; // Infrastructure error — don't block pipeline
    }
  }

  // Persist VQA retry metrics to DB
  if (retryCount > 0) {
    await updateRunRecord(runId, {
      visual_qa_retry_count: retryCount,
      visual_qa_retry_cost_usd: totalRetryCost,
    });
  }

  return { visualQAResult, analystOutput, publishResult, retryCount, totalRetryCost };
}
