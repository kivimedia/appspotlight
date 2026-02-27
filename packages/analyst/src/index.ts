import { createLogger, getConfig, calculateCost, getVercelDeploymentUrl, getProjectType, getAppOverrides } from '@appspotlight/shared';
import type { AnalystOutput, ProjectType } from '@appspotlight/shared';
import { cloneAndReadRepo, cleanupRepo } from './repo-reader.js';
import { generateContent } from './content-generator.js';
import { captureScreenshots } from './screenshot-capture.js';
import { calculateConfidence } from './confidence.js';
import { diagnoseDeployment, waitForRedeploy } from './deployment-doctor.js';

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

  // Resolve project type from config
  const projectType = getProjectType(repoFiles.meta.repoName);
  const overrides = getAppOverrides(repoFiles.meta.repoName);
  log.info(`Project type: ${projectType}`);

  try {
    // Step 2: Generate content via Claude
    log.info('Step 2/4: Generating content via Claude...');
    const contentResult = await generateContent(repoFiles, undefined, projectType);

    // Determine deployed URL
    // Priority: explicit override > package.json homepage > Vercel API > static config map
    let deployedUrl: string | null = options.deployedUrl
      ?? repoFiles.meta.homepageUrl
      ?? config.deployUrlMap[repoFiles.meta.repoName]
      ?? null;

    // If no URL found yet, try Vercel API detection
    if (!deployedUrl && config.vercel?.token) {
      log.info('Checking Vercel for deployment URL...');
      deployedUrl = await getVercelDeploymentUrl(repoFiles.meta.repoName, config);
    }

    // Step 3: Capture screenshots
    log.info('Step 3/4: Capturing screenshots...');
    let { screenshots, durationSec } = await captureScreenshots(
      deployedUrl,
      repoFiles.meta.repoName,
      {
        projectType,
        description: repoFiles.meta.description,
        techStack: overrides.techStack ?? repoFiles.meta.languages,
      }
    );

    // Step 3b: If URL was unreachable, try the Deployment Doctor
    const allPlaceholders = screenshots.every(s => s.filename.includes('placeholder'));
    if (deployedUrl && allPlaceholders) {
      log.info('═══ Deployment Doctor: URL unreachable — diagnosing... ═══');
      const diagnosis = await diagnoseDeployment(deployedUrl, repoFiles.clonePath, true);

      if (diagnosis.fixApplied) {
        log.info(`Fix applied: ${diagnosis.fixDescription} — waiting for redeploy...`);
        const isBack = await waitForRedeploy(deployedUrl);

        if (isBack) {
          log.info('Site is back up — retrying screenshot capture');
          const retry = await captureScreenshots(deployedUrl, repoFiles.meta.repoName);
          screenshots = retry.screenshots;
          durationSec += retry.durationSec;
        } else {
          log.warn('Site did not come back after fix — keeping placeholder screenshots');
        }
      } else {
        log.info(`Deployment Doctor: ${diagnosis.diagnosis}`);
      }
    }

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
      deployedUrlReachable,
      projectType
    );

    const costData = calculateCost(
      contentResult.inputTokens,
      contentResult.outputTokens,
      contentResult.modelUsed,
      durationSec
    );

    // Always set CTA URL to a known-good URL — never trust Claude's guess
    // Priority: config override > deployed URL > GitHub repo URL
    if (overrides.ctaUrl) {
      contentResult.content.cta_url = overrides.ctaUrl;
      log.info(`  CTA URL set from config: ${overrides.ctaUrl}`);
    } else if (deployedUrl) {
      contentResult.content.cta_url = deployedUrl;
      log.info(`  CTA URL set to deployed: ${deployedUrl}`);
    } else {
      // Fall back to GitHub repo URL — always exists
      contentResult.content.cta_url = repoUrl.replace(/\.git$/, '');
      log.info(`  CTA URL set to repo: ${contentResult.content.cta_url}`);
    }

    // Apply CTA label override from config
    if (overrides.ctaLabel) {
      contentResult.content.cta_text = overrides.ctaLabel;
      log.info(`  CTA text set from config: ${overrides.ctaLabel}`);
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
      projectType,
    };
  } finally {
    // Always clean up cloned repo
    cleanupRepo(repoFiles.clonePath);
  }
}

/**
 * Regenerate content with QA feedback — used for auto-retry.
 * Re-clones repo, calls Claude with feedback context, keeps original screenshots.
 */
export async function regenerateContent(
  repoUrl: string,
  previousOutput: AnalystOutput,
  qaFailures: string[]
): Promise<AnalystOutput> {
  log.info(`═══ Retrying content for: ${previousOutput.repoMeta.repoName} ═══`);
  log.info(`QA failures to fix: ${qaFailures.join('; ')}`);

  const repoFiles = await cloneAndReadRepo(repoUrl);
  const projectType = previousOutput.projectType ?? getProjectType(previousOutput.repoMeta.repoName);

  try {
    const contentResult = await generateContent(repoFiles, {
      previousContent: previousOutput.content,
      qaFailures,
    }, projectType);

    const features = contentResult.content.features ?? [];
    const audience = contentResult.content.target_audience ?? '';
    contentResult.content.features = features;
    contentResult.content.target_audience = audience;

    const confidence = calculateConfidence(
      repoFiles,
      features.length,
      audience.length > 10,
      previousOutput.screenshots,
      previousOutput.confidenceBreakdown.deployedUrlReachable,
      projectType
    );

    const costData = calculateCost(
      contentResult.inputTokens,
      contentResult.outputTokens,
      contentResult.modelUsed,
      0 // no new screenshots
    );

    // Always set CTA to known-good URL — use previous CTA (already resolved)
    contentResult.content.cta_url = previousOutput.content.cta_url;

    log.info(`✓ Retry complete for "${contentResult.content.app_name}"`);
    log.info(`  Confidence: ${confidence.totalScore}/100 (was ${previousOutput.confidence})`);
    log.info(`  Features: ${features.length}`);
    log.info(`  Retry cost: $${costData.total_cost_usd.toFixed(4)}`);

    return {
      content: contentResult.content,
      screenshots: previousOutput.screenshots,
      confidence: confidence.totalScore,
      confidenceBreakdown: confidence,
      costData,
      repoMeta: previousOutput.repoMeta,
      projectType,
    };
  } finally {
    cleanupRepo(repoFiles.clonePath);
  }
}

// Re-export sub-modules for direct access
export { cloneAndReadRepo, cleanupRepo } from './repo-reader.js';
export { generateContent } from './content-generator.js';
export { captureScreenshots } from './screenshot-capture.js';
export { calculateConfidence } from './confidence.js';
export { diagnoseDeployment, waitForRedeploy } from './deployment-doctor.js';
export type { DiagnosisResult } from './deployment-doctor.js';
