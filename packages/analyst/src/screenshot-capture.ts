import { chromium, type Browser, type Page } from 'playwright';
import sharp from 'sharp';
import { createLogger, getConfig } from '@appspotlight/shared';
import type { ScreenshotResult } from '@appspotlight/shared';

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
  repoName: string
): Promise<{ screenshots: ScreenshotResult[]; durationSec: number }> {
  const config = getConfig();
  const startTime = Date.now();

  if (!deployedUrl) {
    log.warn('No deployed URL — generating placeholder screenshots');
    return {
      screenshots: [createPlaceholder(repoName, 'Coming Soon')],
      durationSec: 0,
    };
  }

  log.info(`Capturing screenshots from ${deployedUrl}`);

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

    // Try scrolling down the home page for "below the fold" content
    const pageHeight = await desktopPage.evaluate(() => document.body.scrollHeight);
    const viewportHeight = config.screenshots.desktopViewport.height;

    if (pageHeight > viewportHeight * 1.5) {
      // Scroll to middle of page and capture
      try {
        await desktopPage.evaluate((vh) => window.scrollTo(0, vh), viewportHeight);
        await desktopPage.waitForTimeout(1000);
        const midBuf = await captureAndOptimize(desktopPage, config);
        if (midBuf.length / 1024 >= 5) {
          screenshots.push({
            buffer: midBuf,
            filename: `${repoName}-scroll-mid-desktop.webp`,
            label: 'Features / Content',
            viewport: 'desktop',
            sizeKb: midBuf.length / 1024,
          });
        }
      } catch (e) {
        log.warn(`Scroll-mid screenshot failed: ${(e as Error).message}`);
      }

      // Scroll to bottom and capture
      if (pageHeight > viewportHeight * 2.5) {
        try {
          await desktopPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight - window.innerHeight));
          await desktopPage.waitForTimeout(1000);
          const bottomBuf = await captureAndOptimize(desktopPage, config);
          if (bottomBuf.length / 1024 >= 5) {
            screenshots.push({
              buffer: bottomBuf,
              filename: `${repoName}-scroll-bottom-desktop.webp`,
              label: 'Footer / CTA',
              viewport: 'desktop',
              sizeKb: bottomBuf.length / 1024,
            });
          }
        } catch (e) {
          log.warn(`Scroll-bottom screenshot failed: ${(e as Error).message}`);
        }
      }

      // Scroll back to top for further navigation
      await desktopPage.evaluate(() => window.scrollTo(0, 0));
    }

    // Try internal links only if we still need more screenshots
    if (screenshots.length < config.screenshots.maxScreenshots) {
      const links = await findInternalLinks(desktopPage, deployedUrl);

      for (let i = 0; i < Math.min(links.length, 2); i++) {
        if (screenshots.length >= config.screenshots.maxScreenshots) break;
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

    // Mobile screenshot
    try {
      const mobilePage = await browser.newPage({
        viewport: config.screenshots.mobileViewport,
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
