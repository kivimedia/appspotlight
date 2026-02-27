import { chromium, type Browser, type Page } from 'playwright';
import sharp from 'sharp';
import { createLogger, getConfig, getAppAuthCredentials, getAppOverrides, isNonWebProject } from '@appspotlight/shared';
import type { ScreenshotResult, AppAuthStrategy, ProjectType } from '@appspotlight/shared';
import { generateBrandedPlaceholder } from './branded-placeholder.js';

const log = createLogger('screenshots');

// Placeholder screenshot labels if we capture fewer screens
const SCREEN_LABELS = [
  'Home / Landing',
  'Main Feature',
  'Dashboard / Settings',
  'Detail View',
  'Mobile View',
];

export async function captureScreenshots(
  deployedUrl: string | null,
  repoName: string,
  options?: {
    projectType?: ProjectType;
    description?: string | null;
    techStack?: string[];
  }
): Promise<{ screenshots: ScreenshotResult[]; durationSec: number }> {
  const config = getConfig();
  const startTime = Date.now();
  const projectType = options?.projectType ?? 'web-app';

  // For non-web projects, always generate branded placeholders (skip Playwright entirely)
  if (isNonWebProject(projectType)) {
    log.info(`Non-web project (${projectType}) — generating branded card`);
    const overrides = getAppOverrides(repoName);
    const screenshots = await generateBrandedPlaceholder(
      overrides.displayName ?? repoName,
      repoName,
      projectType,
      options?.description,
      options?.techStack ?? overrides.techStack
    );
    return { screenshots, durationSec: 0 };
  }

  // Web app without a deployed URL — use branded placeholder instead of basic SVG
  if (!deployedUrl) {
    log.warn('No deployed URL — generating branded card');
    const overrides = getAppOverrides(repoName);
    const screenshots = await generateBrandedPlaceholder(
      overrides.displayName ?? repoName,
      repoName,
      projectType,
      options?.description,
      options?.techStack ?? overrides.techStack
    );
    return { screenshots, durationSec: 0 };
  }

  // Apply per-app overrides (e.g., maxScreenshots)
  const overrides = config.appOverrides?.[repoName] ?? {};
  const effectiveMaxScreenshots = overrides.maxScreenshots ?? config.screenshots.maxScreenshots;
  log.info(`Capturing screenshots from ${deployedUrl} (max: ${effectiveMaxScreenshots})`);

  // Check if this app has an auth strategy for post-login screenshots
  const authStrategy = config.appAuth?.[repoName];
  const credentials = getAppAuthCredentials(repoName);

  if (authStrategy && credentials) {
    log.info(`Auth strategy found for "${repoName}" — attempting authenticated capture`);
    try {
      const authResult = await captureAuthenticatedScreenshots(
        deployedUrl, repoName, authStrategy, credentials, config, startTime, effectiveMaxScreenshots
      );
      if (authResult.screenshots.length > 0) {
        return authResult;
      }
      log.warn('Auth capture returned 0 screenshots — falling back to public capture');
    } catch (e) {
      log.warn(`Auth capture failed: ${(e as Error).message} — falling back to public capture`);
    }
  }

  // Public (unauthenticated) capture — existing flow
  return capturePublicScreenshots(deployedUrl, repoName, config, startTime, effectiveMaxScreenshots);
}

// ─── Authenticated Capture ──────────────────────────────────────────────────

async function captureAuthenticatedScreenshots(
  deployedUrl: string,
  repoName: string,
  strategy: AppAuthStrategy,
  credentials: { email: string; password: string },
  config: ReturnType<typeof getConfig>,
  startTime: number,
  maxScreenshots: number
): Promise<{ screenshots: ScreenshotResult[]; durationSec: number }> {
  const screenshots: ScreenshotResult[] = [];
  const browser = await chromium.launch({ headless: true });

  try {
    // Desktop context for login + screenshots
    const desktopCtx = await browser.newContext({
      viewport: config.screenshots.desktopViewport,
    });
    const desktopPage = await desktopCtx.newPage();

    // Login
    const loginOk = await executeLogin(desktopPage, deployedUrl, strategy, credentials);
    if (!loginOk) {
      await browser.close();
      throw new Error('Login failed — could not authenticate');
    }

    // Capture each post-login page (desktop)
    for (const target of strategy.postLoginPages) {
      if (screenshots.length >= maxScreenshots - 1) break; // reserve 1 for mobile
      try {
        const targetUrl = deployedUrl.replace(/\/$/, '') + target.path;
        log.info(`  Capturing ${target.label} (desktop): ${targetUrl}`);
        await navigateSafely(desktopPage, targetUrl);
        await desktopPage.waitForTimeout(config.screenshots.waitAfterLoadMs);

        // Verify we weren't redirected back to login
        if (desktopPage.url().includes(strategy.loginPath)) {
          log.warn(`  Redirected to login — session may have expired, skipping ${target.label}`);
          continue;
        }

        const buf = await captureAndOptimize(desktopPage, config);
        if (buf.length / 1024 < 5) {
          log.warn(`  Skipping blank screenshot for ${target.label} (${(buf.length / 1024).toFixed(1)}KB)`);
          continue;
        }

        const safeName = target.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        screenshots.push({
          buffer: buf,
          filename: `${repoName}-${safeName}-desktop.webp`,
          label: target.label,
          viewport: 'desktop',
          sizeKb: buf.length / 1024,
        });
        log.info(`  Captured ${target.label}: ${(buf.length / 1024).toFixed(1)}KB`);
      } catch (e) {
        log.warn(`  Failed to capture ${target.label}: ${(e as Error).message}`);
      }
    }

    // Mobile screenshot — copy auth cookies from desktop context
    try {
      const mobileCtx = await browser.newContext({
        viewport: config.screenshots.mobileViewport,
        deviceScaleFactor: 2,
      });
      const cookies = await desktopCtx.cookies();
      await mobileCtx.addCookies(cookies);

      const mobilePage = await mobileCtx.newPage();
      const firstPage = strategy.postLoginPages[0];
      const mobileUrl = deployedUrl.replace(/\/$/, '') + firstPage.path;
      log.info(`  Capturing ${firstPage.label} (mobile): ${mobileUrl}`);
      await navigateSafely(mobilePage, mobileUrl);
      await mobilePage.waitForTimeout(config.screenshots.waitAfterLoadMs);

      const mobileBuf = await captureAndOptimize(mobilePage, config);
      if (mobileBuf.length / 1024 >= 5) {
        const safeName = firstPage.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        screenshots.push({
          buffer: mobileBuf,
          filename: `${repoName}-${safeName}-mobile.webp`,
          label: `${firstPage.label} (Mobile)`,
          viewport: 'mobile',
          sizeKb: mobileBuf.length / 1024,
        });
        log.info(`  Captured mobile: ${(mobileBuf.length / 1024).toFixed(1)}KB`);
      }

      await mobileCtx.close();
    } catch (e) {
      log.warn(`  Mobile screenshot failed: ${(e as Error).message}`);
    }

    await desktopCtx.close();
  } finally {
    await browser.close();
  }

  const durationSec = (Date.now() - startTime) / 1000;
  log.info(`Auth capture: ${screenshots.length} screenshots in ${durationSec.toFixed(1)}s`);
  return { screenshots, durationSec };
}

async function executeLogin(
  page: Page,
  deployedUrl: string,
  strategy: AppAuthStrategy,
  credentials: { email: string; password: string }
): Promise<boolean> {
  const loginUrl = deployedUrl.replace(/\/$/, '') + strategy.loginPath;
  log.info(`  Logging in at ${loginUrl}...`);

  const reached = await navigateSafely(page, loginUrl);
  if (!reached) {
    log.warn('  Login page not reachable');
    return false;
  }
  await page.waitForTimeout(2000);

  try {
    // Fill email
    await page.fill('input[type="email"]', credentials.email);
    await page.waitForTimeout(500);

    if (strategy.multiStep) {
      // Click continue/next button
      const continuePattern = new RegExp(strategy.continueButtonText ?? 'continue|next', 'i');
      const continueBtn = page.locator('button').filter({ hasText: continuePattern }).first();
      await continueBtn.click();
      await page.waitForTimeout(3000);
    }

    // Fill password
    const passwordField = page.locator('input[type="password"]');
    await passwordField.waitFor({ state: 'visible', timeout: 10000 });
    await passwordField.fill(credentials.password);

    // Click sign-in button
    const signInPattern = new RegExp(strategy.signInButtonText ?? 'sign in|log in|submit', 'i');
    const signInBtn = page.locator('button').filter({ hasText: signInPattern }).first();
    await signInBtn.click();

    // Wait for redirect
    const waitMs = strategy.waitAfterLoginMs ?? 5000;
    await page.waitForTimeout(waitMs);

    // Verify login succeeded — URL should no longer contain login path
    if (page.url().includes(strategy.loginPath)) {
      log.warn(`  Login failed — still on ${page.url()}`);
      return false;
    }

    log.info(`  Login successful! URL: ${page.url()}`);
    return true;
  } catch (e) {
    log.warn(`  Login error: ${(e as Error).message}`);
    return false;
  }
}

// ─── Public (Unauthenticated) Capture ───────────────────────────────────────

async function capturePublicScreenshots(
  deployedUrl: string,
  repoName: string,
  config: ReturnType<typeof getConfig>,
  startTime: number,
  maxScreenshots: number
): Promise<{ screenshots: ScreenshotResult[]; durationSec: number }> {
  let browser: Browser | null = null;
  const screenshots: ScreenshotResult[] = [];

  try {
    browser = await chromium.launch({ headless: true });

    // Desktop screenshots
    const desktopPage = await browser.newPage({
      viewport: config.screenshots.desktopViewport,
    });

    // Try to load the page
    const reachable = await navigateSafely(desktopPage, deployedUrl);
    if (!reachable) {
      log.warn(`URL not reachable: ${deployedUrl}`);
      await browser.close();
      return {
        screenshots: [createPlaceholder(repoName, 'App Not Yet Deployed')],
        durationSec: (Date.now() - startTime) / 1000,
      };
    }

    // Wait for dynamic content
    await desktopPage.waitForTimeout(config.screenshots.waitAfterLoadMs);

    // Screenshot 1: Home page (desktop)
    const homeBuffer = await captureAndOptimize(desktopPage, config);
    screenshots.push({
      buffer: homeBuffer,
      filename: `${repoName}-home-desktop.webp`,
      label: SCREEN_LABELS[0],
      viewport: 'desktop',
      sizeKb: homeBuffer.length / 1024,
    });

    // Scroll through the page and capture at evenly-spaced positions
    const pageHeight = await desktopPage.evaluate(() => document.body.scrollHeight);
    const viewportHeight = config.screenshots.desktopViewport.height;
    const scrollableHeight = pageHeight - viewportHeight;

    if (scrollableHeight > viewportHeight * 0.5) {
      // Reserve 2 slots: 1 for internal links, 1 for mobile
      const scrollBudget = Math.max(1, maxScreenshots - screenshots.length - 2);
      const scrollSteps = Math.min(scrollBudget, Math.floor(scrollableHeight / viewportHeight));
      const scrollLabels = ['Features / Content', 'Details', 'More Content', 'Gallery', 'Footer / CTA'];

      for (let step = 1; step <= scrollSteps; step++) {
        const scrollY = step === scrollSteps
          ? scrollableHeight // last step = bottom
          : Math.round((scrollableHeight * step) / (scrollSteps + 1));

        try {
          await desktopPage.evaluate((y) => window.scrollTo(0, y), scrollY);
          await desktopPage.waitForTimeout(1000);
          const buf = await captureAndOptimize(desktopPage, config);
          if (buf.length / 1024 >= 5) {
            const label = scrollLabels[step - 1] ?? `Section ${step}`;
            screenshots.push({
              buffer: buf,
              filename: `${repoName}-scroll-${step}-desktop.webp`,
              label,
              viewport: 'desktop',
              sizeKb: buf.length / 1024,
            });
          }
        } catch (e) {
          log.warn(`Scroll step ${step} screenshot failed: ${(e as Error).message}`);
        }
      }

      // Scroll back to top for further navigation
      await desktopPage.evaluate(() => window.scrollTo(0, 0));
    }

    // Try internal links only if we still need more screenshots
    if (screenshots.length < maxScreenshots) {
      const links = await findInternalLinks(desktopPage, deployedUrl);

      for (let i = 0; i < Math.min(links.length, maxScreenshots - screenshots.length); i++) {
        if (screenshots.length >= maxScreenshots) break;
        try {
          await navigateSafely(desktopPage, links[i]);
          await desktopPage.waitForTimeout(config.screenshots.waitAfterLoadMs);

          const buf = await captureAndOptimize(desktopPage, config);
          // Skip blank/near-blank screenshots (< 5KB is likely empty)
          if (buf.length / 1024 < 5) {
            log.warn(`Skipping blank screenshot from ${links[i]} (${(buf.length / 1024).toFixed(1)}KB)`);
            continue;
          }
          screenshots.push({
            buffer: buf,
            filename: `${repoName}-screen${i + 2}-desktop.webp`,
            label: SCREEN_LABELS[i + 1] ?? `Screen ${i + 2}`,
            viewport: 'desktop',
            sizeKb: buf.length / 1024,
          });
        } catch (e) {
          log.warn(`Failed to capture screen ${i + 2}: ${(e as Error).message}`);
        }
      }
    }

    // Mobile screenshot — use 2x DPR for crisp rendering (like a real phone)
    try {
      const mobilePage = await browser.newPage({
        viewport: config.screenshots.mobileViewport,
        deviceScaleFactor: 2,
      });
      await navigateSafely(mobilePage, deployedUrl);
      await mobilePage.waitForTimeout(config.screenshots.waitAfterLoadMs);

      const mobileBuf = await captureAndOptimize(mobilePage, config);
      screenshots.push({
        buffer: mobileBuf,
        filename: `${repoName}-home-mobile.webp`,
        label: 'Mobile View',
        viewport: 'mobile',
        sizeKb: mobileBuf.length / 1024,
      });
      await mobilePage.close();
    } catch (e) {
      log.warn(`Mobile screenshot failed: ${(e as Error).message}`);
    }

    await desktopPage.close();
  } catch (e) {
    log.error(`Screenshot capture failed: ${(e as Error).message}`);
    if (screenshots.length === 0) {
      screenshots.push(createPlaceholder(repoName, 'Screenshot Error'));
    }
  } finally {
    if (browser) await browser.close();
  }

  const durationSec = (Date.now() - startTime) / 1000;
  log.info(`Captured ${screenshots.length} screenshots in ${durationSec.toFixed(1)}s`);
  return { screenshots, durationSec };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function navigateSafely(page: Page, url: string): Promise<boolean> {
  try {
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    return response !== null && response.status() < 400;
  } catch {
    return false;
  }
}

async function captureAndOptimize(
  page: Page,
  config: ReturnType<typeof getConfig>
): Promise<Buffer> {
  const rawBuffer = await page.screenshot({ type: 'png', fullPage: false });

  // Optimize with Sharp: resize + convert to WebP
  const optimized = await sharp(rawBuffer)
    .resize({ width: config.screenshots.maxWidthPx, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  // If still too large, reduce quality further
  if (optimized.length > config.screenshots.maxFileSizeKb * 1024) {
    return sharp(rawBuffer)
      .resize({ width: config.screenshots.maxWidthPx, withoutEnlargement: true })
      .webp({ quality: 60 })
      .toBuffer();
  }

  return optimized;
}

async function findInternalLinks(page: Page, baseUrl: string): Promise<string[]> {
  try {
    const origin = new URL(baseUrl).origin;
    const links = await page.evaluate((orig) => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(href =>
          href.startsWith(orig) &&
          !href.includes('#') &&
          !href.endsWith('.pdf') &&
          !href.endsWith('.png') &&
          !href.endsWith('.jpg')
        );
    }, origin);

    // Dedupe and exclude the current page
    const unique = [...new Set(links)].filter(l => l !== baseUrl && l !== baseUrl + '/');
    return unique.slice(0, 5);
  } catch {
    return [];
  }
}

function createPlaceholder(repoName: string, text: string): ScreenshotResult {
  // Create a simple SVG placeholder, convert to WebP
  const svg = `<svg width="1440" height="900" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#131829"/>
    <text x="50%" y="45%" font-family="sans-serif" font-size="48" fill="#6C63FF" text-anchor="middle">${repoName}</text>
    <text x="50%" y="55%" font-family="sans-serif" font-size="24" fill="#9CA3BE" text-anchor="middle">${text}</text>
  </svg>`;

  const buffer = Buffer.from(svg);
  return {
    buffer,
    filename: `${repoName}-placeholder.webp`,
    label: text,
    viewport: 'desktop',
    sizeKb: buffer.length / 1024,
  };
}
