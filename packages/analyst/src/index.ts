import { createLogger, getConfig, calculateCost } from '@appspotlight/shared';
import type { AnalystOutput } from '@appspotlight/shared';
import { cloneAndReadRepo, cleanupRepo } from './repo-reader.js';
import { generateContent } from './content-generator.js';
import { captureScreenshots } from './screenshot-capture.js';
import { calculateConfidence } from './confidence.js';

const log = createLogger('analyst');

export interface AnalyzeOptions {
  repoUrl: string;
  deployedUrl?: string | null;
}

/**
 * Main Analyst entry point.
 * Clones repo, reads code, generates content via Claude, captures screenshots.
 */
export async function analyzeRepo(options: AnalyzeOptions): Promise<AnalystOutput> {
  const config = getConfig();
  const { repoUrl } = options;

  log.info(`═══ Analyzing: ${repoUrl} ═══`);

  // Step 1: Clone and read repo
  log.info('Step 1/4: Cloning and reading repo...');
  const repoFiles = await cloneAndReadRepo(repoUrl);

  try {
    // Step 2: Generate content via Claude
    log.info('Step 2/4: Generating content via Claude...');
    const contentResult = await generateContent(repoFiles);

    // Determine deployed URL
    const deployedUrl = options.deployedUrl
      ?? repoFiles.meta.homepageUrl
      ?? config.deployUrlMap[repoFiles.meta.repoName]
      ?? null;

    // Step 3: Capture screenshots
    log.info('Step 3/4: Capturing screenshots...');
    const { screenshots, durationSec } = await captureScreenshots(
      deployedUrl,
      repoFiles.meta.repoName
    );

    // Step 4: Calculate confidence and cost
    log.info('Step 4/4: Calculating confidence and cost...');

    // Ensure arrays have safe defaults
    const features = contentResult.content.features ?? [];
    const audience = contentResult.content.target_audience ?? '';
    contentResult.content.features = features;
    contentResult.content.target_audience = audience;

    const deployedUrlReachable = deployedUrl !== null &&
      screenshots.some(s => !s.filename.includes('placeholder'));

    const confidence = calculateConfidence(
      repoFiles,
      features.length,
      audience.length > 10,
      screenshots,
      deployedUrlReachable
    );

    const costData = calculateCost(
      contentResult.inputTokens,
      contentResult.outputTokens,
      contentResult.modelUsed,
      durationSec
    );

    // If content doesn't have a valid CTA URL, try the deployed URL
    if (contentResult.content.cta_url === '/contact' && deployedUrl) {
      contentResult.content.cta_url = deployedUrl;
    }

    log.info(`✓ Analysis complete for "${contentResult.content.app_name}"`);
    log.info(`  Confidence: ${confidence.totalScore}/100`);
    log.info(`  Features: ${features.length}`);
    log.info(`  Screenshots: ${screenshots.length}`);
    log.info(`  Cost: $${costData.total_cost_usd.toFixed(4)}`);
    log.info(`  Model: ${contentResult.modelUsed}`);

    return {
      content: contentResult.content,
      screenshots,
      confidence: confidence.totalScore,
      confidenceBreakdown: confidence,
      costData,
      repoMeta: repoFiles.meta,
    };
  } finally {
    // Always clean up cloned repo
    cleanupRepo(repoFiles.clonePath);
  }
}

// Re-export sub-modules for direct access
export { cloneAndReadRepo, cleanupRepo } from './repo-reader.js';
export { generateContent } from './content-generator.js';
export { captureScreenshots } from './screenshot-capture.js';
export { calculateConfidence } from './confidence.js';
