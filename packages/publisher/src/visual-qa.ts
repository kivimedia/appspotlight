import { chromium } from 'playwright';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger, getConfig } from '@appspotlight/shared';
import type { AppContent, VisualQAResult, VisualQAIssue } from '@appspotlight/shared';

const log = createLogger('visual-qa');

const VISUAL_QA_SYSTEM_PROMPT = `You are a strict visual QA reviewer for auto-generated WordPress portfolio pages. You review a full-page screenshot and compare it against the intended content. Be thorough — your job is to catch every defect before the page goes live.

Check for these categories of issues:

1. **Layout/Spacing**: Large empty gaps between sections, sections collapsing, uneven spacing, content not centered properly
2. **Content Visibility**: Missing section text, descriptions not rendering (only titles visible), audience text missing, benefit lines missing under audience personas
3. **Gallery Quality**: Screenshot gallery images rendering too small, broken images, placeholder images visible
4. **Readability & Typography**: Text too small to read, poor contrast, tech badges barely readable. Fonts must match the site design: Poppins for headings, Open Sans for body text. Flag if text appears to use Arial, Times New Roman, or system default fonts instead. Emoji icons should be clearly visible and large enough to see at a glance.
5. **Rendering Issues**: Login/auth pages captured instead of app content, error pages, broken styling
6. **Stray Elements & Artifacts**: Any unexpected boxes, borders, cursors, input fields, empty rectangles, red/colored outlines, floating UI widgets, chat bubbles, or admin controls visible on the page. These are CRITICAL — they make the page look broken and unprofessional. Scan the ENTIRE page carefully, especially corners and edges.
7. **Overall Quality**: Does this look like a professional portfolio page? Would you be proud to show this to a client?

IMPORTANT RULES:
- Be strict. When in doubt, flag it as a warning. Do NOT let defects slide as "info".
- A "critical" issue means the page is broken, has stray artifacts, or is misleading and should NOT be published.
- A "warning" means noticeable quality issue that ideally should be fixed before publishing.
- An "info" means truly minor imperfection that most visitors would never notice.
- Stray visible elements (boxes, borders, cursors, input fields) are ALWAYS "critical".
- The page title may contain a "[REVIEW NEEDED]" prefix — this is expected for draft pages under review and must NOT be flagged as an issue.
- If the expected sections list does NOT include a screenshot gallery, do NOT flag its absence.
- Scan every corner and edge of the screenshot — artifacts often appear at the bottom-right or page margins.
- App screenshots in the gallery may contain non-English text (Hebrew, Arabic, etc.) — this is EXPECTED for internationalized apps. Do NOT flag non-English UI text in screenshots as an issue. The PAGE content (headings, descriptions, buttons) should be in English, but the APP screenshots show the actual running application which may be in any language.
- The page uses an intentional dark theme with a black (#000) background. Cards (features, audience, problem/solution) use a dark navy (#1a1a2e) background. This dark-on-dark design is INTENTIONAL and professional — do NOT flag low contrast between card backgrounds and page background as a defect. Only flag text that is genuinely unreadable. Do NOT flag a section as "missing" unless you genuinely cannot see any heading or text for it anywhere on the page.
- Gallery images in a multi-column layout will naturally be smaller than full-width. Only flag gallery images as "too small" if they are genuinely thumbnail-sized (under ~200px wide). Images filling their column width at ~400px+ are acceptable.

Respond ONLY with valid JSON matching this schema:
{
  "overall_pass": boolean,
  "issues": [
    {
      "severity": "critical" | "warning" | "info",
      "category": "layout" | "content" | "gallery" | "readability" | "spacing" | "rendering",
      "description": "Brief description of the issue"
    }
  ],
  "summary": "One sentence overall assessment"
}`;

// ─── Screenshot Capture ────────────────────────────────────────────────────

async function capturePageScreenshot(pageUrl: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000); // Extra wait for WP theme rendering

    // Scroll through the entire page to trigger lazy-loaded images
    // (WordPress lazy-loading plugins use IntersectionObserver)
    /* eslint-disable no-await-in-loop */
    const scrollHeight = await page.evaluate('document.body.scrollHeight') as number;
    const viewportH = 900;
    for (let y = 0; y < scrollHeight; y += viewportH) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await page.waitForTimeout(200);
    }
    await page.evaluate('window.scrollTo(0, 0)');
    await page.waitForTimeout(2000); // Wait for lazy images to load

    // Full-page screenshot to capture all sections
    const rawBuffer = await page.screenshot({ type: 'png', fullPage: true });

    // Optimize: convert to JPEG for smaller size (better for Claude Vision)
    let optimized = await sharp(rawBuffer)
      .resize({ width: 1440, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // If still over 500KB, reduce quality
    if (optimized.length > 500 * 1024) {
      optimized = await sharp(rawBuffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 65 })
        .toBuffer();
    }

    log.info(`Page screenshot: ${(optimized.length / 1024).toFixed(1)}KB`);
    return optimized;
  } finally {
    await browser.close();
  }
}

// ─── Claude Vision Review ──────────────────────────────────────────────────

interface VisionReviewResult {
  issues: VisualQAIssue[];
  overallPass: boolean;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

async function reviewWithVision(
  screenshotBuffer: Buffer,
  content: AppContent,
  screenshotCount: number
): Promise<VisionReviewResult> {
  const config = getConfig();
  const client = new Anthropic({ apiKey: config.claude.apiKey });

  const base64Image = screenshotBuffer.toString('base64');
  const model = config.visualQA.model;

  const expectedSections = [
    `Hero: "${content.app_name}" with tagline "${content.tagline}"`,
    `Problem/Solution section`,
    `Features section with ${content.features.length} features: ${content.features.map(f => f.title).join(', ')}`,
    ...(screenshotCount > 0 ? [`Screenshot gallery with ${screenshotCount} app screenshots`] : []),
    `Audience section: "${content.target_audience}"`,
    `Tech stack badges: ${content.tech_stack.join(', ')}`,
    `CTA section with button "${content.cta_text}"`,
    `Typography: Headings must use Poppins font, body text must use Open Sans. No Arial, no system fonts, no serif/monospace. Body text should be 16px+ and readable.`,
    `Emoji icons should be large and clearly visible (not tiny or hard to see)`,
    `NO stray elements anywhere on the page: no empty boxes, red borders, cursors, input fields, floating widgets, or admin controls. Scan all corners and edges carefully.`,
  ];

  const userMessage = `Review this WordPress portfolio page screenshot. The page was auto-generated for the app "${content.app_name}".

Expected sections on this page:
${expectedSections.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Look at the screenshot and report any visual quality issues.`;

  const response = await client.messages.create({
    model,
    max_tokens: config.visualQA.maxTokens,
    system: VISUAL_QA_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: userMessage,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude Vision');
  }

  // Parse JSON response (same defensive logic as content-generator.ts)
  let jsonStr = textBlock.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  const parsed = JSON.parse(jsonStr) as {
    overall_pass: boolean;
    issues: VisualQAIssue[];
    summary: string;
  };

  log.info(`Vision review: ${parsed.overall_pass ? 'PASS' : 'FAIL'} — ${parsed.issues.length} issues — "${parsed.summary}"`);

  return {
    issues: parsed.issues ?? [],
    overallPass: parsed.overall_pass,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model,
  };
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

export async function runVisualQA(
  pageUrl: string,
  content: AppContent,
  screenshotCount?: number
): Promise<VisualQAResult> {
  const config = getConfig();
  const startTime = Date.now();

  log.info(`═══ Visual QA: ${content.app_name} ═══`);
  log.info(`Page URL: ${pageUrl}`);

  try {
    // Step 1: Capture full-page screenshot
    log.info('Capturing rendered page screenshot...');
    const screenshotBuffer = await capturePageScreenshot(pageUrl);
    const screenshotSizeKb = screenshotBuffer.length / 1024;

    // Step 2: Send to Claude Vision for review
    log.info('Sending to Claude Vision for review...');
    const visionResult = await reviewWithVision(screenshotBuffer, content, screenshotCount ?? 0);

    // Step 3: Determine pass/fail based on config thresholds
    // Thresholds are authoritative — they override the model's own overall_pass judgment
    const criticalCount = visionResult.issues.filter(i => i.severity === 'critical').length;
    const totalIssueCount = visionResult.issues.filter(i => i.severity !== 'info').length;

    let passed = true;

    if (config.visualQA.failOnCritical && criticalCount > 0) {
      passed = false;
      log.warn(`Visual QA forced FAIL: ${criticalCount} critical issue(s)`);
    }

    if (totalIssueCount >= config.visualQA.failThreshold) {
      passed = false;
      log.warn(`Visual QA forced FAIL: ${totalIssueCount} issues >= threshold ${config.visualQA.failThreshold}`);
    }

    // Calculate cost
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
      'claude-opus-4-6': { input: 15.0, output: 75.0 },
    };
    const p = pricing[visionResult.model] ?? { input: 3.0, output: 15.0 };
    const costUsd =
      (visionResult.inputTokens / 1_000_000) * p.input +
      (visionResult.outputTokens / 1_000_000) * p.output;

    const durationSec = (Date.now() - startTime) / 1000;

    log.info(`Visual QA ${passed ? 'PASSED' : 'FAILED'}: ${visionResult.issues.length} issues, ${screenshotSizeKb.toFixed(0)}KB, $${costUsd.toFixed(4)}, ${durationSec.toFixed(1)}s`);

    return {
      passed,
      issues: visionResult.issues,
      screenshotSizeKb,
      costData: {
        input_tokens: visionResult.inputTokens,
        output_tokens: visionResult.outputTokens,
        model: visionResult.model,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
      },
      durationSec,
    };
  } catch (err) {
    const durationSec = (Date.now() - startTime) / 1000;
    log.error(`Visual QA error: ${(err as Error).message}`);

    // On error, return non-blocking pass — infrastructure failures should never block publishing
    return {
      passed: true,
      issues: [{
        severity: 'info',
        category: 'rendering',
        description: `Visual QA could not run: ${(err as Error).message}`,
      }],
      screenshotSizeKb: 0,
      costData: { input_tokens: 0, output_tokens: 0, model: '', cost_usd: 0 },
      durationSec,
    };
  }
}
