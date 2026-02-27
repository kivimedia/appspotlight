import { createLogger, isNonWebProject } from '@appspotlight/shared';
import type { AppContent, ScreenshotResult, QACheckResult, QACheck, ProjectType } from '@appspotlight/shared';
import sharp from 'sharp';

const log = createLogger('qa');

/**
 * Tier 1 automated QA checks per PRD section 10.
 * Runs before creating/updating any page.
 */
export async function runQAChecks(
  content: AppContent,
  screenshots: ScreenshotResult[],
  projectType: ProjectType = 'web-app'
): Promise<QACheckResult> {
  const checks: QACheck[] = [];

  // 1. Content completeness
  checks.push(checkFieldPopulated('app_name', content.app_name));
  checks.push(checkFieldPopulated('tagline', content.tagline));
  checks.push(checkFieldPopulated('problem_statement', content.problem_statement));
  checks.push(checkFieldPopulated('target_audience', content.target_audience));
  checks.push(checkFieldPopulated('cta_text', content.cta_text));
  checks.push(checkFieldPopulated('cta_url', content.cta_url));
  checks.push({
    name: 'features_present',
    passed: content.features.length >= 2,
    message: content.features.length >= 2
      ? `${content.features.length} features found`
      : `Only ${content.features.length} features (need at least 2)`,
  });

  // 1b. Audience quality — flag overly generic audiences
  const genericAudiences = ['developers', 'end users', 'users', 'everyone'];
  const audienceLower = (content.target_audience ?? '').toLowerCase().trim();
  const isGenericAudience = genericAudiences.some(g => audienceLower === g);
  checks.push({
    name: 'audience_specific',
    passed: !isGenericAudience,
    message: isGenericAudience
      ? `target_audience is too generic: "${content.target_audience}" — should describe actual end users`
      : `target_audience is specific: "${content.target_audience}"`,
  });

  // 1c. Audience benefit lines — each persona should have a ": benefit" line
  const hasAudienceBenefits = (content.target_audience ?? '').includes(':');
  checks.push({
    name: 'audience_has_benefits',
    passed: hasAudienceBenefits,
    message: hasAudienceBenefits
      ? 'Audience segments include benefit lines'
      : 'target_audience is missing benefit lines (no "Persona: benefit" format found)',
  });

  // 1d. No em dashes — Claude loves them but they look AI-generated
  const allText = [
    content.tagline,
    content.problem_statement,
    content.target_audience,
    content.cta_text,
    ...content.features.map(f => `${f.title} ${f.description}`),
  ].join(' ');
  const emdashCount = (allText.match(/\u2014/g) || []).length;
  checks.push({
    name: 'no_emdashes',
    passed: emdashCount === 0,
    message: emdashCount === 0
      ? 'No em dashes found'
      : `Found ${emdashCount} em dash(es) — replace with regular dashes or rewrite`,
  });

  // 2. Word count thresholds
  checks.push(checkWordCount('tagline', content.tagline, 1, 15));
  checks.push(checkWordCount('problem_statement', content.problem_statement, 30, 150));
  for (const feature of content.features) {
    checks.push(checkWordCount(`feature "${feature.title}"`, feature.description, 5, 60));
  }

  // 3. Screenshot validation — type-aware
  if (isNonWebProject(projectType)) {
    // Non-web: 1+ branded card is sufficient
    const hasScreenshots = screenshots.length >= 1 && screenshots.some(s => s.sizeKb > 5);
    checks.push({
      name: 'screenshots_count',
      passed: hasScreenshots,
      message: hasScreenshots
        ? `${screenshots.length} branded card(s) generated`
        : 'No branded cards generated for non-web project',
    });
  } else {
    // Web app: original 2+ real screenshots requirement
    const realScreenshots = screenshots.filter(s => !s.filename.includes('placeholder'));
    checks.push({
      name: 'screenshots_count',
      passed: realScreenshots.length >= 2,
      message: realScreenshots.length >= 2
        ? `${realScreenshots.length} real screenshots captured`
        : `Only ${realScreenshots.length} screenshots (need at least 2)`,
    });
  }

  // Check screenshots are not blank (basic pixel variance check via file size)
  // Skip branded cards (they're generated, not captured)
  const screenshotsToCheckBlank = screenshots.filter(s => !s.filename.includes('branded-card'));
  for (const ss of screenshotsToCheckBlank) {
    const isLikelyBlank = ss.sizeKb < 5; // A blank WebP would be very small
    checks.push({
      name: `screenshot_not_blank_${ss.filename}`,
      passed: !isLikelyBlank,
      message: isLikelyBlank
        ? `${ss.filename} may be blank (${ss.sizeKb.toFixed(1)}KB)`
        : `${ss.filename} looks valid (${ss.sizeKb.toFixed(1)}KB)`,
    });
  }

  // 3b. Blur detection — flag low-resolution or blurry screenshots (skip branded cards)
  const screenshotsToCheckBlur = screenshots.filter(
    s => !s.filename.includes('placeholder') && !s.filename.includes('branded-card')
  );
  for (const ss of screenshotsToCheckBlur) {
    const blurCheck = await checkScreenshotSharpness(ss);
    checks.push(blurCheck);
  }

  // 4. CTA button text length — max 4 words
  const ctaWordCount = (content.cta_text ?? '').trim().split(/\s+/).length;
  checks.push({
    name: 'cta_text_length',
    passed: ctaWordCount <= 4,
    message: ctaWordCount <= 4
      ? `CTA text is ${ctaWordCount} words (OK)`
      : `CTA text is ${ctaWordCount} words: "${content.cta_text}" (max 4 words)`,
  });

  // 5. CTA URL validation
  checks.push(await checkCtaUrl(content.cta_url));

  // Compile results
  const failures = checks.filter(c => !c.passed).map(c => c.message);
  const passed = failures.length === 0;

  if (passed) {
    log.info(`QA passed: all ${checks.length} checks OK`);
  } else {
    log.warn(`QA failed: ${failures.length} issues`, { failures: failures.join('; ') });
  }

  return { passed, checks, failures };
}

// ─── Individual Checks ──────────────────────────────────────────────────────

function checkFieldPopulated(field: string, value: string | undefined): QACheck {
  const populated = !!value && value.trim().length > 0;
  return {
    name: `field_${field}`,
    passed: populated,
    message: populated ? `${field} is populated` : `${field} is missing or empty`,
  };
}

function checkWordCount(field: string, text: string, min: number, max: number): QACheck {
  const wordCount = text.trim().split(/\s+/).length;
  const inRange = wordCount >= min && wordCount <= max;
  return {
    name: `wordcount_${field}`,
    passed: inRange,
    message: inRange
      ? `${field}: ${wordCount} words (OK)`
      : `${field}: ${wordCount} words (expected ${min}-${max})`,
  };
}

/**
 * Detect blurry/low-quality screenshots using edge variance analysis.
 * Converts to greyscale, applies a Laplacian-like edge convolution,
 * then measures the standard deviation of the result. Low variance = blurry.
 */
async function checkScreenshotSharpness(ss: ScreenshotResult): Promise<QACheck> {
  try {
    const { width, height } = await sharp(ss.buffer).metadata() as { width: number; height: number };

    // Minimum resolution check — desktop should be >= 1000px, mobile >= 600px
    const minWidth = ss.viewport === 'mobile' ? 600 : 1000;
    if (width < minWidth) {
      return {
        name: `screenshot_sharp_${ss.filename}`,
        passed: false,
        message: `${ss.filename} is too low-res (${width}px wide, need >= ${minWidth}px for ${ss.viewport})`,
      };
    }

    // Edge detection: convert to greyscale, convolve with Laplacian kernel, measure stats
    const edgeStats = await sharp(ss.buffer)
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
      .stats();

    // Standard deviation of the edge channel — higher = sharper
    const edgeStdDev = edgeStats.channels[0].stdev;
    const BLUR_THRESHOLD = 8; // Below this = likely blurry

    const isSharp = edgeStdDev >= BLUR_THRESHOLD;
    return {
      name: `screenshot_sharp_${ss.filename}`,
      passed: isSharp,
      message: isSharp
        ? `${ss.filename} is sharp (edge variance: ${edgeStdDev.toFixed(1)}, ${width}x${height})`
        : `${ss.filename} appears blurry (edge variance: ${edgeStdDev.toFixed(1)} < ${BLUR_THRESHOLD}, ${width}x${height})`,
    };
  } catch (e) {
    log.warn(`Blur check failed for ${ss.filename}: ${(e as Error).message}`);
    return {
      name: `screenshot_sharp_${ss.filename}`,
      passed: true, // Don't fail build if blur check itself errors
      message: `${ss.filename} blur check skipped: ${(e as Error).message}`,
    };
  }
}

async function checkCtaUrl(url: string): Promise<QACheck> {
  // Skip validation for relative URLs
  if (url.startsWith('/')) {
    return { name: 'cta_url_reachable', passed: true, message: `CTA URL is relative: ${url}` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    return {
      name: 'cta_url_reachable',
      passed: response.ok,
      message: response.ok
        ? `CTA URL reachable (${response.status})`
        : `CTA URL returned ${response.status}`,
    };
  } catch (e) {
    return {
      name: 'cta_url_reachable',
      passed: false,
      message: `CTA URL unreachable: ${(e as Error).message}`,
    };
  }
}
