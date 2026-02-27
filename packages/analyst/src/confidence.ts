import type { ConfidenceBreakdown, ScreenshotResult, ProjectType } from '@appspotlight/shared';
import { isNonWebProject } from '@appspotlight/shared';
import type { RepoFiles } from './repo-reader.js';

/**
 * Calculate confidence score (0-100) based on how much context was extracted.
 *
 * Web-app scoring:
 *   - README present:              +20
 *   - Deployed URL reachable:      +25
 *   - 3+ features identified:      +20
 *   - Clear target audience:       +15
 *   - 2+ real screenshots:         +20
 *
 * Non-web scoring (CLI, automation, desktop, VS Code, library):
 *   - README present:              +25  (more important for non-UI projects)
 *   - Branded card generated:      +25  (replaces deployed URL)
 *   - 3+ features identified:      +20
 *   - Clear target audience:       +15
 *   - Tech stack detected:         +15  (replaces screenshots)
 */
export function calculateConfidence(
  repoFiles: RepoFiles,
  featuresCount: number,
  hasAudience: boolean,
  screenshots: ScreenshotResult[],
  deployedUrlReachable: boolean,
  projectType: ProjectType = 'web-app'
): ConfidenceBreakdown {
  const readmePresent = repoFiles.priorityFiles.some(
    f => f.path.toLowerCase().startsWith('readme')
  );

  const featuresIdentified = featuresCount >= 3;

  if (isNonWebProject(projectType)) {
    // Non-web scoring: don't require deployed URL or browser screenshots
    const hasBrandedCard = screenshots.length >= 1 && screenshots[0].sizeKb > 5;
    const hasTechStack = repoFiles.priorityFiles.some(
      f => f.path === 'package.json' || f.path === 'requirements.txt' ||
           f.path === 'Cargo.toml' || f.path === 'go.mod' || f.path === 'pyproject.toml'
    );

    const score =
      (readmePresent ? 25 : 0) +
      (hasBrandedCard ? 25 : 0) +
      (featuresIdentified ? 20 : 0) +
      (hasAudience ? 15 : 0) +
      (hasTechStack ? 15 : 0);

    return {
      readmePresent,
      deployedUrlReachable: false, // N/A for non-web
      featuresIdentified,
      clearAudience: hasAudience,
      screenshotsCaptured: hasBrandedCard,
      totalScore: score,
      projectType,
    };
  }

  // Web-app scoring: original logic unchanged
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
    projectType,
  };
}
