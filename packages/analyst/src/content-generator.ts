import Anthropic from '@anthropic-ai/sdk';
import { createLogger, getConfig, selectModel } from '@appspotlight/shared';
import type { AppContent, CostData, FeedbackContext, ProjectType } from '@appspotlight/shared';
import { calculateCost } from '@appspotlight/shared';
import type { RepoFiles } from './repo-reader.js';

const log = createLogger('content-gen');

const SYSTEM_PROMPT = `You are AppSpotlight, an expert at analyzing application codebases and generating compelling one-pager marketing content for a developer portfolio.

You will receive extracted code context from a GitHub repository. Analyze the code to understand:
- What the app does and what problem it solves
- Who it's built for
- Key features and capabilities
- The tech stack used

Generate marketing content that is professional, concise, and compelling. Write for an audience of potential clients, fellow developers, and podcast listeners.

IMPORTANT RULES:
- Be specific, not generic. Use details from the actual code.
- The tagline must be punchy and under 12 words.
- Problem statement should be 2-3 sentences, focusing on real pain points.
- The solution section MUST directly address each pain point from the problem statement. If the problem mentions "clunky equipment," the solution must explain how this app eliminates that. Mirror the problem's language so the narrative flows naturally.
- Each feature needs a descriptive title, one clear sentence, and a unique emoji icon that visually represents THAT specific feature. Pick emojis based on the feature content — never use the same emoji twice. Be creative: 🔐 for security, 🎵 for music, 📱 for mobile, 💬 for chat, 📈 for analytics, 🗂️ for organization, etc.
- Benefits should be outcome-focused (what the user gains), not feature-focused.
- Tech stack should list actual technologies found in the code.
- If you cannot determine something from the code, make your best educated guess based on the evidence.
- NEVER use em dashes (—). Use regular dashes (-) or rewrite the sentence instead.

TARGET AUDIENCE - BE SPECIFIC:
- NEVER use broad categories like "Music lovers," "Karaoke enthusiasts," or "Party hosts." These are too generic and don't resonate.
- Instead, describe specific scenarios and frustrations. Examples:
  BAD: "Karaoke enthusiasts: Find and sing your favorite songs"
  GOOD: "House party hosts tired of hunting YouTube for karaoke versions: One search, instant karaoke for any song"
  BAD: "Music lovers: Discover new songs"
  GOOD: "DJs who want to add karaoke nights to their gig lineup: Professional-quality vocal removal without expensive gear"
- Each persona should paint a vivid picture of WHO they are and WHAT specific frustration this app solves for them.

CTA TEXT - MATCH THE DESTINATION:
- If the CTA URL points to a live app or product, use action words like "Try It Free," "Start Now," or "Launch App."
- If the CTA URL points to /contact or a consultation page, use conversational words like "Let's Talk" or "Get in Touch."
- NEVER use conversational CTA text (e.g. "Let's Talk Karaoke") that links to a product URL - it sets the wrong expectation.

Respond ONLY with valid JSON matching the schema below. No markdown, no explanation, just JSON.`;

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    app_name: { type: 'string' as const, description: 'Human-friendly app name' },
    tagline: { type: 'string' as const, description: 'One-line description, max 12 words' },
    problem_statement: { type: 'string' as const, description: '2-3 sentences on what pain point this solves' },
    target_audience: { type: 'string' as const, description: 'Pipe-separated list of 2-3 audience segments. Each segment: a SPECIFIC persona with a scenario-based benefit. Format: "Specific persona: Vivid one-line benefit". Be concrete - describe WHO they are and WHAT frustration this solves. BAD: "Music lovers: Discover new songs". GOOD: "DJs adding karaoke to their gig lineup: Professional vocal removal without expensive gear". NEVER use generic labels like "enthusiasts" or "lovers".' },
    features: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
          description: { type: 'string' as const },
          icon: { type: 'string' as const, description: 'A single emoji that visually represents THIS specific feature. Choose based on the feature content — e.g. 🔐 for security, 📱 for mobile, 🎵 for music, 💬 for chat, 📈 for analytics. NEVER repeat the same emoji twice. Be creative and specific.' },
        },
        required: ['title', 'description', 'icon'],
      },
      description: '3-5 key features with title + 1 sentence description + contextual emoji icon',
    },
    benefits: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: '2-3 outcome-focused benefits',
    },
    tech_stack: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Primary technologies used',
    },
    cta_text: { type: 'string' as const, description: 'Call to action button text — MUST be 4 words or fewer. If cta_url is a live app, use action words like "Try It Free" or "Start Singing." If cta_url is /contact, use "Get in Touch." NEVER use conversational text like "Let\'s Talk X" for a product link.' },
    cta_url: { type: 'string' as const, description: 'Link destination' },
  },
  required: ['app_name', 'tagline', 'problem_statement', 'target_audience', 'features', 'benefits', 'tech_stack', 'cta_text', 'cta_url'],
};

// Project-type-specific prompt additions
const PROJECT_TYPE_PROMPTS: Record<string, string> = {
  'cli-tool': `This is a CLI (command-line) tool. It has no web UI.
- CTA should be "View on GitHub" or "Install via npm" - NOT "Try It Free" or "Launch App".
- Focus on what commands it provides and what problems they solve.
- Features should describe CLI capabilities, not UI screens.`,

  'automation': `This is an automation tool/pipeline/script. It runs in the background or via scripts, not in a browser.
- CTA should be "View on GitHub" - NOT "Try It Free" or "Launch App".
- Focus on what it automates and how much time/effort it saves.
- Features should describe the automation workflow steps or capabilities.
- Highlight integration points (APIs, services it connects to).`,

  'desktop-app': `This is a desktop application (likely Electron). It runs locally, not in a browser.
- CTA should be "Download" or "View on GitHub" - NOT "Launch App".
- Focus on the desktop user experience.
- Mention that it runs locally (privacy, speed benefits).`,

  'vscode-extension': `This is a VS Code extension. It installs from the VS Code Marketplace.
- CTA should be "Install Extension" - link to the VS Code Marketplace.
- Focus on what it adds to the VS Code editing experience.
- Features should describe editor capabilities, commands, keyboard shortcuts.
- Target audience is developers using VS Code.`,

  'library': `This is a code library/SDK. It's consumed by other developers as a dependency.
- CTA should be "View on GitHub" or "Install via npm".
- Focus on the API surface, ease of integration, and developer experience.`,
};

export interface ContentResult {
  content: AppContent;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
}

export async function generateContent(repoFiles: RepoFiles, feedbackContext?: FeedbackContext, projectType?: ProjectType): Promise<ContentResult> {
  const config = getConfig();

  const modelUsed = selectModel(
    repoFiles.meta.linesOfCode,
    config.claude.opusThreshold,
    config.claude.defaultModel,
    config.claude.opusModel
  );

  log.info(`Using model: ${modelUsed} (${repoFiles.meta.linesOfCode} LOC)`);

  const client = new Anthropic({ apiKey: config.claude.apiKey });

  // Build the code context message
  const codeContext = buildCodeContext(repoFiles);

  // Inject project type context if applicable
  const typePrompt = projectType && PROJECT_TYPE_PROMPTS[projectType]
    ? `\n**Project Type:** ${projectType}\n\n${PROJECT_TYPE_PROMPTS[projectType]}\n`
    : '';

  const userMessage = `Analyze this codebase and generate marketing content for a portfolio page.

**Repository:** ${repoFiles.meta.repoName}
**URL:** ${repoFiles.meta.repoUrl}
**Description:** ${repoFiles.meta.description ?? 'Not provided'}
**Homepage:** ${repoFiles.meta.homepageUrl ?? 'Not deployed yet'}
**Languages:** ${repoFiles.meta.languages.join(', ')}
**Lines of Code:** ${repoFiles.meta.linesOfCode}${typePrompt}

---

${codeContext}

---

Generate the JSON content now using EXACTLY these field names:

\`\`\`
{
  "app_name": "Human-friendly app name",
  "tagline": "One-line description, max 12 words",
  "problem_statement": "2-3 sentences on what pain point this solves (30-150 words)",
  "target_audience": "Specific persona: vivid benefit | Another persona: vivid benefit | Third persona: vivid benefit",
  "features": [
    { "title": "Feature Name", "description": "One clear sentence", "icon": "single emoji" }
  ],
  "benefits": ["Outcome-focused benefit 1", "Outcome-focused benefit 2"],
  "tech_stack": ["Tech1", "Tech2", "Tech3"],
  "cta_text": "4 words max",
  "cta_url": "deployed URL or /contact"
}
\`\`\`

CRITICAL: Use EXACTLY these field names. Do NOT invent new fields. Do NOT use "painPoint", "audience", "description" etc. — use "problem_statement", "target_audience", "tagline".

If the app has a deployed URL, use it for cta_url. Otherwise use /contact as the CTA URL. Provide 3-5 features.`;

  // Build messages — optionally include feedback context for retry
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  if (feedbackContext) {
    log.info('Including feedback context for retry...');
    // Add the previous (bad) response as assistant context
    messages.push({
      role: 'assistant',
      content: JSON.stringify(feedbackContext.previousContent),
    });
    // Add correction request with specific QA failures
    messages.push({
      role: 'user',
      content: `Your previous response had these quality issues:\n${feedbackContext.qaFailures.map(f => `- ${f}`).join('\n')}\n\nPlease regenerate the JSON fixing these specific issues. Ensure you provide at least 3-5 detailed features, a clear target audience, a problem statement of 2-3 full sentences (30-150 words), and a tagline under 12 words. Keep what was good, only fix the flagged problems.`,
    });
  }

  log.info(`Sending ${userMessage.length} chars to Claude...${feedbackContext ? ' (with feedback)' : ''}`);

  const response = await client.messages.create({
    model: modelUsed,
    max_tokens: config.claude.maxOutputTokens,
    system: SYSTEM_PROMPT,
    messages,
  });

  // Extract text content
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Parse JSON from response (handle markdown code blocks and text before/after JSON)
  let jsonStr = textBlock.text.trim();

  // Strip markdown code fences
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  // If response has text before/after JSON, extract the JSON object
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  let content: AppContent;
  try {
    content = JSON.parse(jsonStr);
  } catch (parseErr) {
    // Try to recover truncated JSON by closing open brackets/braces
    log.warn(`JSON parse failed, attempting truncation recovery...`);
    let recovered = jsonStr;
    // Remove trailing incomplete string/value
    recovered = recovered.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '');
    // Count open brackets and close them
    const openBraces = (recovered.match(/\{/g) || []).length - (recovered.match(/\}/g) || []).length;
    const openBrackets = (recovered.match(/\[/g) || []).length - (recovered.match(/\]/g) || []).length;
    recovered += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
    try {
      content = JSON.parse(recovered);
      log.info(`Truncation recovery succeeded`);
    } catch {
      log.error(`Failed to parse Claude JSON response. Raw text (first 500 chars):`);
      log.error(textBlock.text.substring(0, 500));
      throw new Error(`JSON parse failed: ${(parseErr as Error).message}`);
    }
  }

  // Log what we got for debugging
  log.info(`Parsed fields: app_name=${!!content.app_name}, tagline=${!!content.tagline}, features=${content.features?.length ?? 0}, audience=${!!content.target_audience}`);

  // Coerce fields that Claude sometimes returns as arrays instead of strings
  if (Array.isArray(content.target_audience)) {
    content.target_audience = content.target_audience.join(' | ');
  }
  if (typeof content.target_audience !== 'string') {
    content.target_audience = '';
  }

  // Validate minimum required fields — fill defaults for missing optional ones
  if (!content.app_name) {
    content.app_name = repoFiles.meta.repoName;
  }
  if (!content.tagline) {
    content.tagline = content.app_name;
  }
  if (!content.features || content.features.length === 0) {
    content.features = [{ title: 'Core Feature', description: 'See repository for details.' }];
  }
  if (!content.target_audience || content.target_audience.toLowerCase() === 'developers') {
    const hint = `${content.app_name} ${content.tagline} ${content.problem_statement}`.toLowerCase();
    content.target_audience = inferAudienceFromHint(hint);
    log.info(`  Inferred target audience: ${content.target_audience}`);
  }
  // Ensure audience has benefit lines — if missing colons, replace with domain-specific personas
  if (content.target_audience && !content.target_audience.includes(':')) {
    log.warn('  target_audience has no benefit lines (no colons found) — replacing with domain-specific personas');
    const hint = `${content.app_name} ${content.tagline} ${content.problem_statement}`.toLowerCase();
    content.target_audience = inferAudienceFromHint(hint);
    log.info(`  Reformatted target audience: ${content.target_audience}`);
  }
  if (!content.problem_statement) {
    content.problem_statement = `${content.app_name} helps solve common challenges in its domain.`;
  }
  if (!content.benefits) {
    content.benefits = ['Streamlined workflow'];
  }
  if (!content.tech_stack) {
    content.tech_stack = repoFiles.meta.languages;
  }
  if (!content.cta_text) {
    content.cta_text = 'Learn More';
  }
  // Enforce max 4 words for CTA button text
  const ctaWords = content.cta_text.trim().split(/\s+/);
  if (ctaWords.length > 4) {
    log.warn(`  CTA text too long (${ctaWords.length} words): "${content.cta_text}" — truncating to 4 words`);
    content.cta_text = ctaWords.slice(0, 4).join(' ');
  }
  if (!content.cta_url) {
    content.cta_url = repoFiles.meta.homepageUrl ?? '/contact';
  }

  // Strip em dashes — Claude loves them but they look AI-generated
  const stripEmdash = (s: string) => (s ?? '').replace(/\u2014/g, ' - ');
  content.tagline = stripEmdash(content.tagline);
  content.problem_statement = stripEmdash(content.problem_statement);
  content.target_audience = stripEmdash(content.target_audience);
  content.cta_text = stripEmdash(content.cta_text);
  for (const f of content.features) {
    f.title = stripEmdash(f.title);
    f.description = stripEmdash(f.description);
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  log.info(`Generated content for "${content.app_name}" — ${inputTokens} in / ${outputTokens} out tokens`);

  return {
    content,
    inputTokens,
    outputTokens,
    modelUsed,
  };
}

// ─── Audience Inference ──────────────────────────────────────────────────────

/** Word-boundary check: avoids "sing" matching "processing" */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text);
}

/**
 * Infer audience from app hint text (lowercase name + tagline + problem).
 * Order matters — most specific categories first, broader ones later.
 */
function inferAudienceFromHint(hint: string): string {
  // Most specific first: karaoke before generic music/song
  if (hasWord(hint, 'karaoke')) {
    return 'House party hosts tired of hunting YouTube for karaoke versions: One search, instant karaoke for any song | DJs adding karaoke nights to their gig lineup: Professional vocal removal without expensive hardware | Friend groups who miss singing together: Start a session from anywhere and invite people to join';
  }
  // Invoice/email/send — check before choir since "send" is specific
  if (hasWord(hint, 'invoice') || hasWord(hint, 'email') || hasWord(hint, 'send') || hasWord(hint, 'contact') || hint.includes('amram')) {
    return 'Small business owners drowning in paper invoices: Scan, organize, and track payments from one inbox | Freelancers chasing late payments: Automated reminders that follow up so you don\'t have to | Accountants managing multiple clients: Pull every invoice into one dashboard without manual data entry';
  }
  // Deploy/devops
  if (hasWord(hint, 'deploy') || hasWord(hint, 'devops') || hint.includes('ci/cd') || hasWord(hint, 'infrastructure')) {
    return 'Solo developers juggling multiple deploy targets: One checklist that tracks every service and environment | Small teams where "it works on my machine" is a daily problem: Shared deployment steps everyone can follow | Startup CTOs who need visibility without building internal tooling: See every deploy status at a glance';
  }
  // Choir/vocal — use word boundaries for "sing" to avoid matching "processing"
  if (hasWord(hint, 'choir') || hasWord(hint, 'sing') || hasWord(hint, 'singing') || hasWord(hint, 'vocal') || hasWord(hint, 'choral')) {
    return "Choir conductors managing 30+ singers with different skill levels: Track each voice part's progress in one dashboard | Amateur singers who want to improve but can't afford private lessons: AI-powered practice sessions that adapt to your range | Music educators building curriculum for mixed-ability groups: Create custom playlists that challenge every level";
  }
  // Generic music/song (after karaoke and choir)
  if (hasWord(hint, 'music') || hasWord(hint, 'song') || hasWord(hint, 'lyric')) {
    return 'Bedroom producers looking for the right sample: Search by mood, tempo, or genre and preview instantly | Music teachers building lesson plans: Curate playlists that match your curriculum goals | Playlist curators who outgrew Spotify folders: Organize, tag, and share collections your way';
  }
  // Cooking
  if (hasWord(hint, 'cook') || hasWord(hint, 'recipe') || hasWord(hint, 'food')) {
    return 'Home cooks who keep losing track of recipes saved in 10 different apps: One searchable library for everything you cook | Meal preppers planning a full week of dinners: Auto-generate shopping lists from your selected recipes | Food bloggers turning recipes into content: Beautiful formatting and sharing built right in';
  }
  // Fitness
  if (hasWord(hint, 'fitness') || hasWord(hint, 'workout') || hasWord(hint, 'health')) {
    return 'Gym-goers who scribble workouts on their phone notes: Structured logging that tracks sets, reps, and progress over time | Personal trainers managing 10+ clients remotely: Assign programs and see compliance without chasing screenshots | New Year resolvers who quit by February: Smart reminders and streak tracking that keep you accountable';
  }
  // Automation / pipeline
  if (hasWord(hint, 'pipeline') || hasWord(hint, 'automation') || hasWord(hint, 'scraper') || hasWord(hint, 'crawler') || hasWord(hint, 'spotlight')) {
    return 'Dev teams running repetitive manual workflows: Automate your pipeline and reclaim hours every week | Solo developers who need enterprise-level automation: Production-grade orchestration without the DevOps team | Agencies managing content for multiple clients: Run batch operations across accounts without switching tabs';
  }
  // VS Code / extension
  if (hasWord(hint, 'vscode') || hasWord(hint, 'extension') || hasWord(hint, 'editor') || hasWord(hint, 'window') || hasWord(hint, 'rename')) {
    return 'Developers who lose context switching between windows: Keep your workspace organized with smart naming | Teams sharing VS Code setups: Consistent window labels across everyone\'s machine | Power users managing 10+ VS Code windows daily: Instantly identify the right window without hovering';
  }
  // Inventory / stock / equipment
  if (hasWord(hint, 'inventory') || hasWord(hint, 'stock') || hasWord(hint, 'equipment') || hasWord(hint, 'warehouse') || hasWord(hint, 'stage')) {
    return 'Stage crews tracking hundreds of rental items: Know exactly what\'s in stock and what\'s on a truck | Production managers planning events with limited gear: Avoid double-booking equipment across shows | Small business owners who outgrew spreadsheet inventory: Searchable, filterable catalog that updates in real time';
  }
  // Scanner / security / API key
  if (hasWord(hint, 'scanner') || hasWord(hint, 'secret') || hasWord(hint, 'credential') || hasWord(hint, 'vault')) {
    return 'Developers who accidentally committed API keys: Catch secrets before they reach GitHub | Security-conscious teams running pre-commit checks: Automated scanning that blocks leaks at the source | DevOps engineers auditing existing repos for exposure: Scan entire codebases and get actionable reports';
  }
  // SEO
  if (hasWord(hint, 'seo') || hasWord(hint, 'content marketing') || hasWord(hint, 'keyword')) {
    return 'Marketing teams producing SEO content at scale: Generate optimized articles with coordinated multi-agent workflows | Agencies managing SEO for multiple clients: One pipeline that handles research, writing, and optimization | Solo content creators competing with big publishers: Enterprise-grade SEO tooling without the enterprise price';
  }
  // CRM / 17hats / export
  if (hasWord(hint, 'crm') || hasWord(hint, '17hats') || hasWord(hint, 'export') || hasWord(hint, 'hats')) {
    return 'Business owners trapped by their CRM\'s export limitations: Pull your own data out, no vendor lock-in | Freelancers migrating between platforms: Get clean, structured exports of all your contacts and records | Accountants who need CRM data in spreadsheets: Automated extraction that saves hours of manual copy-paste';
  }
  // Balloon / decoration / events
  if (hasWord(hint, 'balloon') || hasWord(hint, 'decoration') || hasWord(hint, 'event') || hasWord(hint, 'carolina')) {
    return 'Event decorators managing bookings across multiple weekends: One calendar for all your gigs, with reminders | Small decoration businesses tracking inquiries and deposits: From lead to confirmed booking in one dashboard | Balloon artists who want a professional web presence: Showcase your portfolio and accept bookings online';
  }
  // Generic fallback
  return 'Teams wasting hours on manual processes that should be automated: Streamline your workflow with one click | Managers who need visibility but hate micromanaging: Dashboards that surface what matters without asking | Solo operators wearing every hat in the business: Do the work of a team from a single interface';
}

// ─── Build Code Context ─────────────────────────────────────────────────────

function buildCodeContext(repoFiles: RepoFiles): string {
  const sections: string[] = [];

  if (repoFiles.priorityFiles.length > 0) {
    sections.push('## Priority Files (README, package.json, etc.)');
    for (const f of repoFiles.priorityFiles) {
      sections.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }

  if (repoFiles.entryPoints.length > 0) {
    sections.push('\n## Entry Points');
    for (const f of repoFiles.entryPoints) {
      sections.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }

  if (repoFiles.routeFiles.length > 0) {
    sections.push('\n## Routes / Pages');
    for (const f of repoFiles.routeFiles) {
      sections.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }

  if (repoFiles.uiComponents.length > 0) {
    sections.push('\n## UI Components (first 10)');
    for (const f of repoFiles.uiComponents) {
      sections.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }

  if (repoFiles.schemaFiles.length > 0) {
    sections.push('\n## Schemas / Models');
    for (const f of repoFiles.schemaFiles) {
      sections.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }

  return sections.join('\n\n');
}
