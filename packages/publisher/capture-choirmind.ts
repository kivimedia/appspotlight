/**
 * One-off: Capture post-login screenshots of ChoirMind with a populated account.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const DIR = join(process.env.TEMP || '/tmp', 'choirmind-ss');
mkdirSync(DIR, { recursive: true });

const EMAIL = 'test-ss2@appspotlight.local';
const PASSWORD = 'TestUser1234';

async function login(page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>>) {
  console.log('  Navigating to sign-in...');
  await page.goto('https://choirmind.vercel.app/auth/signin', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Step 1: Enter email
  await page.fill('input[type="email"]', EMAIL);
  await page.waitForTimeout(500);
  const continueBtn = page.locator('button').filter({ hasText: /המשך|continue/i }).first();
  await continueBtn.click();
  await page.waitForTimeout(3000);

  // Step 2: Enter password
  const passwordField = page.locator('input[type="password"]');
  await passwordField.waitFor({ state: 'visible', timeout: 10000 });
  await passwordField.fill(PASSWORD);
  const signInBtn = page.locator('button').filter({ hasText: /כניסה|sign in|התחבר/i }).first();
  await signInBtn.click();
  await page.waitForTimeout(6000);

  if (page.url().includes('/auth/signin')) {
    throw new Error('Login failed — still on sign-in page');
  }
  console.log('  Logged in! URL:', page.url());
}

async function captureAndSave(page: any, name: string, width: number) {
  const raw = await page.screenshot({ type: 'png', fullPage: false });
  const optimized = await sharp(raw)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  const outPath = join(DIR, name);
  writeFileSync(outPath, optimized);
  console.log(`  Saved: ${name} (${(optimized.length / 1024).toFixed(1)}KB)`);
  return optimized;
}

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });

  // === DESKTOP SCREENSHOTS ===
  const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktopPage = await desktopCtx.newPage();
  await login(desktopPage);

  const desktopTargets = [
    { url: 'https://choirmind.vercel.app/dashboard', name: 'choirmind-dashboard-desktop.webp', label: 'Dashboard' },
    { url: 'https://choirmind.vercel.app/songs', name: 'choirmind-songs-desktop.webp', label: 'Song Library' },
    { url: 'https://choirmind.vercel.app/practice', name: 'choirmind-practice-desktop.webp', label: 'Practice' },
  ];

  for (const t of desktopTargets) {
    try {
      console.log(`Capturing ${t.label} (desktop)...`);
      await desktopPage.goto(t.url, { waitUntil: 'networkidle', timeout: 20000 });
      await desktopPage.waitForTimeout(3000);
      console.log(`  URL: ${desktopPage.url()}`);
      await captureAndSave(desktopPage, t.name, 1440);
    } catch (e) {
      console.error(`  Failed: ${(e as Error).message}`);
    }
  }

  // === MOBILE SCREENSHOT ===
  // Use deviceScaleFactor: 2 for crisp rendering (like a real phone)
  console.log('Capturing mobile dashboard...');
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const mobilePage = await mobileCtx.newPage();

  // Copy auth cookies from desktop session
  const cookies = await desktopCtx.cookies();
  await mobileCtx.addCookies(cookies);

  await mobilePage.goto('https://choirmind.vercel.app/dashboard', { waitUntil: 'networkidle', timeout: 20000 });
  await mobilePage.waitForTimeout(3000);
  console.log(`  URL: ${mobilePage.url()}`);

  // Capture at 2x DPR, then resize to 780px (phone width * 2) for crisp output
  const mobileRaw = await mobilePage.screenshot({ type: 'png', fullPage: false });
  const mobileOpt = await sharp(mobileRaw)
    .resize({ width: 780, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  const mobilePath = join(DIR, 'choirmind-dashboard-mobile.webp');
  writeFileSync(mobilePath, mobileOpt);
  console.log(`  Saved: choirmind-dashboard-mobile.webp (${(mobileOpt.length / 1024).toFixed(1)}KB)`);

  await mobileCtx.close();
  await desktopCtx.close();
  await browser.close();
  console.log('All done! Screenshots in:', DIR);
}

main().catch(console.error);
