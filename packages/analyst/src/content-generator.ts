import Anthropic from '@anthropic-ai/sdk';
import { createLogger, getConfig, selectModel } from '@appspotlight/shared';
import type { AppContent, CostData, FeedbackContext } from '@appspotlight/shared';
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
- Each feature needs a descriptive title and one clear sentence.
- Benefits should be outcome-focused (what the user gains), not feature-focused.
- Tech stack should list actual technologies found in the code.
- If you cannot determine something from the code, make your best educated guess based on the evidence.
- NEVER use em dashes (—). Use regular dashes (-) or rewrite the sentence instead.

Respond ONLY with valid JSON matching the schema below. No markdown, no explanation, just JSON.`;

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    app_name: { type: 'string' as const, description: 'Human-friendly app name' },
    tagline: { type: 'string' as const, description: 'One-line description, max 12 words' },
    problem_statement: { type: 'string' as const, description: '2-3 sentences on what pain point this solves' },
    target_audience: { type: 'string' as const, description: 'Pipe-separated list of 2-3 audience segments, each with a persona and benefit line separated by a colon. Format: "Persona: One-line benefit | Persona: One-line benefit". Example: "Choir conductors: Track every singer\'s progress in one dashboard | Amateur singers: Practice at your own pace with smart repetition | Music educators: Build custom playlists aligned to your curriculum". NEVER say just "Developers" — describe the END USERS of the app.' },
    features: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
          description: { type: 'string' as const },
        },
        required: ['title', 'description'],
      },
      description: '3-5 key features with title + 1 sentence description',
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
    cta_text: { type: 'string' as const, description: 'Call to action button text' },
    cta_url: { type: 'string' as const, description: 'Link destination' },
  },
  required: ['app_name', 'tagline', 'problem_statement', 'target_audience', 'features', 'benefits', 'tech_stack', 'cta_text', 'cta_url'],
};

export interface ContentResult {
  content: AppContent;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
}

export async function generateContent(repoFiles: RepoFiles, feedbackContext?: FeedbackContext): Promise<ContentResult> {
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

  const userMessage = `Analyze this codebase and generate marketing content for a portfolio page.

**Repository:** ${repoFiles.meta.repoName}
**URL:** ${repoFiles.meta.repoUrl}
**Description:** ${repoFiles.meta.description ?? 'Not provided'}
**Homepage:** ${repoFiles.meta.homepageUrl ?? 'Not deployed yet'}
**Languages:** ${repoFiles.meta.languages.join(', ')}
**Lines of Code:** ${repoFiles.meta.linesOfCode}

---

${codeContext}

---

Generate the JSON content now. If the app has a deployed URL, use it for cta_url. Otherwise use /contact as the CTA URL.`;

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
    log.error(`Failed to parse Claude JSON response. Raw text (first 500 chars):`);
    log.error(textBlock.text.substring(0, 500));
    throw new Error(`JSON parse failed: ${(parseErr as Error).message}`);
  }

  // Log what we got for debugging
  log.info(`Parsed fields: app_name=${!!content.app_name}, tagline=${!!content.tagline}, features=${content.features?.length ?? 0}, audience=${!!content.target_audience}`);

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
    // Infer audience from tagline/app_name instead of generic "Developers"
    const hint = `${content.app_name} ${content.tagline} ${content.problem_statement}`.toLowerCase();
    if (hint.includes('choir') || hint.includes('sing') || hint.includes('vocal') || hint.includes('music')) {
      content.target_audience = 'Choir singers, Choir conductors, Music educators';
    } else if (hint.includes('cook') || hint.includes('recipe') || hint.includes('food')) {
      content.target_audience = 'Home cooks, Food enthusiasts, Recipe creators';
    } else if (hint.includes('fitness') || hint.includes('workout') || hint.includes('health')) {
      content.target_audience = 'Fitness enthusiasts, Personal trainers, Health-conscious individuals';
    } else {
      content.target_audience = 'End users, Teams, Organizations';
    }
    log.info(`  Inferred target audience: ${content.target_audience}`);
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
  if (!content.cta_url) {
    content.cta_url = repoFiles.meta.homepageUrl ?? '/contact';
  }

  // Strip em dashes — Claude loves them but they look AI-generated
  const stripEmdash = (s: string) => s.replace(/\u2014/g, ' - ');
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
