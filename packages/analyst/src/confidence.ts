import type { ConfidenceBreakdown, ScreenshotResult } from '@appspotlight/shared';
import type { RepoFiles } from './repo-reader.js';

/**
 * Calculate confidence score (0-100) based on how much context was extracted.
 *
 * Scoring:
 *   - README present:              +20
 *   - Deployed URL reachable:      +25
 *   - 3+ features identified:      +20
 *   - Clear target audience:       +15
 *   - Screenshots captured:        +20
 */
export function calculateConfidence(
  repoFiles: RepoFiles,
  featuresCount: number,
  hasAudience: boolean,
  screenshots: ScreenshotResult[],
  deployedUrlReachable: boolean
): ConfidenceBreakdown {
  const readmePresent = repoFiles.priorityFiles.some(
    f => f.path.toLowerCase().startsWith('readme')
  );

  const featuresIdentified = featuresCount >= 3;

  const realScreenshots = screenshots.filter(
    s => !s.filename.includes('placeholder')
  );
  const screenshotsCaptured = realScreenshots.length >= 2;

  const score =
    (readmePresent ? 20 : 0) +
    (deployedUrlReachable ? 25 : 0) +
    (featuresIdentified ? 20 : 0) +
    (hasAudience ? 15 : 0) +
    (screenshotsCaptured ? 20 : 0);

  return {
    readmePresent,
    deployedUrlReachable,
    featuresIdentified,
    clearAudience: hasAudience,
    screenshotsCaptured,
    totalScore: score,
  };
}
