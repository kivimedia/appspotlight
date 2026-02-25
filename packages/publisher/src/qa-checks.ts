import { createLogger } from '@appspotlight/shared';
import type { AppContent, ScreenshotResult, QACheckResult, QACheck } from '@appspotlight/shared';

const log = createLogger('qa');

/**
 * Tier 1 automated QA checks per PRD section 10.
 * Runs before creating/updating any page.
 */
export async function runQAChecks(
  content: AppContent,
  screenshots: ScreenshotResult[]
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

  // 2. Word count thresholds
  checks.push(checkWordCount('tagline', content.tagline, 1, 15));
  checks.push(checkWordCount('problem_statement', content.problem_statement, 30, 150));
  for (const feature of content.features) {
    checks.push(checkWordCount(`feature "${feature.title}"`, feature.description, 5, 60));
  }

  // 3. Screenshot validation
  const realScreenshots = screenshots.filter(s => !s.filename.includes('placeholder'));
  checks.push({
    name: 'screenshots_count',
    passed: realScreenshots.length >= 2,
    message: realScreenshots.length >= 2
      ? `${realScreenshots.length} real screenshots captured`
      : `Only ${realScreenshots.length} screenshots (need at least 2)`,
  });

  // Check screenshots are not blank (basic pixel variance check via file size)
  for (const ss of realScreenshots) {
    const isLikelyBlank = ss.sizeKb < 5; // A blank WebP would be very small
    checks.push({
      name: `screenshot_not_blank_${ss.filename}`,
      passed: !isLikelyBlank,
      message: isLikelyBlank
        ? `${ss.filename} may be blank (${ss.sizeKb.toFixed(1)}KB)`
        : `${ss.filename} looks valid (${ss.sizeKb.toFixed(1)}KB)`,
    });
  }

  // 4. CTA URL validation
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
