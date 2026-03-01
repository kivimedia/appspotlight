import { createLogger, getConfig } from '@appspotlight/shared';
import type { AnalystOutput, WPPageResult, WPMediaResult, QACheckResult } from '@appspotlight/shared';
import { findPageBySlug, createPage, updatePage, uploadAllScreenshots, getAppsParentPageId } from './wordpress-client.js';
import { generatePageMarkup } from './page-template.js';
import { runQAChecks } from './qa-checks.js';

const log = createLogger('publisher');

export interface PublishResult {
  pageResult: WPPageResult;
  mediaResults: WPMediaResult[];
  qaResult: QACheckResult;
}

/**
 * Main Publisher entry point.
 * Uploads screenshots, generates page markup, creates/updates WordPress page.
 */
export async function publishApp(analystOutput: AnalystOutput): Promise<PublishResult> {
  const config = getConfig();
  const { content, screenshots, confidence, repoMeta, projectType } = analystOutput;

  log.info(`═══ Publishing: ${content.app_name} ═══`);

  // Step 1: Run QA checks
  log.info('Step 1/4: Running QA checks...');
  const qaResult = await runQAChecks(content, screenshots, projectType);

  // Determine publish status
  let pageStatus: 'publish' | 'draft' = 'publish';
  let pageTitle = content.app_name;

  if (!qaResult.passed || confidence < config.pipeline.autoPublishThreshold) {
    pageStatus = 'draft';
    pageTitle = `[REVIEW NEEDED] ${content.app_name}`;
    log.info(`Page will be draft (confidence: ${confidence}, QA passed: ${qaResult.passed})`);
  } else {
    log.info(`Page will be auto-published (confidence: ${confidence})`);
  }

  // Step 2: Upload screenshots
  log.info('Step 2/4: Uploading screenshots...');
  const mediaResults = await uploadAllScreenshots(screenshots);
  log.info(`Uploaded ${mediaResults.length} screenshots`);

  // Step 3: Generate page markup
  log.info('Step 3/4: Generating page markup...');
  const slug = repoMeta.repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const markup = generatePageMarkup(content, mediaResults, repoMeta.repoName, confidence, repoMeta.repoUrl, projectType);

  // Step 4: Create or update page
  log.info('Step 4/4: Creating/updating WordPress page...');
  const existingPage = await findPageBySlug(slug);
  const parentId = await getAppsParentPageId();

  let pageResult: WPPageResult;

  if (existingPage) {
    log.info(`Page exists (ID: ${existingPage.id}), updating...`);
    pageResult = await updatePage(existingPage.id, pageTitle, markup, pageStatus);
  } else {
    log.info('Creating new page...');
    pageResult = await createPage(
      pageTitle,
      slug,
      markup,
      pageStatus,
      parentId ?? undefined
    );
  }

  log.info(`✓ Published: ${pageResult.pageUrl} (${pageResult.status})`);

  return {
    pageResult,
    mediaResults,
    qaResult,
  };
}

// Re-export sub-modules
export { findPageBySlug, createPage, updatePage, uploadAllScreenshots, publishDraftPage, revertToDraft, fetchChildPages, updateCustomCSS, appendCustomCSS } from './wordpress-client.js';
export { generatePageMarkup } from './page-template.js';
export { runQAChecks } from './qa-checks.js';
export { runVisualQA } from './visual-qa.js';
export { runVisualQAWithRetry } from './visual-qa-retry.js';
export type { VQARetryOptions, VQARetryResult } from './visual-qa-retry.js';
