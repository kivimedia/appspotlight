import type { AppContent, WPMediaResult } from '@appspotlight/shared';

/**
 * Generates Gutenberg block markup matching the ChoirMind one-pager design.
 *
 * Sections:
 * 1. Hero (cover block with gradient, heading, paragraph, CTA buttons)
 * 2. Problem / Solution (two-column layout)
 * 3. Feature Cards (2x2 grid)
 * 4. Screenshot Gallery (gallery block with uploaded media)
 * 5. Who It's For (3 audience cards)
 * 6. Tech Stack Badges (inline badge bar)
 * 7. CTA Section (cover with heading, paragraph, buttons)
 */

const FEATURE_ICONS = ['⚡', '🤖', '📊', '🎯', '🔧', '🚀', '💡', '🔒'];

export function generatePageMarkup(
  content: AppContent,
  mediaResults: WPMediaResult[],
  repoName: string,
  confidence: number
): string {
  const blocks: string[] = [];

  // 1. Hero Section
  blocks.push(buildHeroSection(content));

  // 2. Problem / Solution
  blocks.push(buildProblemSolutionSection(content));

  // 3. Features
  blocks.push(buildFeaturesSection(content));

  // 4. Screenshot Gallery
  if (mediaResults.length > 0) {
    blocks.push(buildGallerySection(mediaResults));
  }

  // 5. Who It's For
  blocks.push(buildAudienceSection(content));

  // 6. Tech Stack Badges
  blocks.push(buildTechStackSection(content));

  // 7. CTA Section
  blocks.push(buildCtaSection(content));

  // Auto-generated badge footer
  blocks.push(buildFooterBadge(repoName, confidence));

  const innerContent = blocks.join('\n\n');

  // Wrap everything in a dark background group to prevent white gaps
  return `<!-- wp:group {"backgroundColor":"black","style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-black-background-color has-background" style="margin-top:0;margin-bottom:0;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0">

${innerContent}

</div>
<!-- /wp:group -->`;
}

// ─── Section Builders ───────────────────────────────────────────────────────

function buildHeroSection(content: AppContent): string {
  return `<!-- wp:cover {"dimRatio":90,"overlayColor":"black","isDark":true,"className":"appspotlight-hero"} -->
<div class="wp-block-cover is-dark appspotlight-hero"><span aria-hidden="true" class="wp-block-cover__background has-black-background-color has-background-dim-90 has-background-dim"></span><div class="wp-block-cover__inner-container">

<!-- wp:heading {"level":1,"style":{"typography":{"fontSize":"3.5rem","fontWeight":"900","lineHeight":"1.1"}},"textColor":"white"} -->
<h1 class="wp-block-heading has-white-color has-text-color" style="font-size:3.5rem;font-weight:900;line-height:1.1">${esc(content.app_name)}</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"1.3rem","lineHeight":"1.6"}},"textColor":"cyan-bluish-gray"} -->
<p style="font-size:1.3rem;line-height:1.6">${esc(content.tagline)}</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"left"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"vivid-cyan-blue","textColor":"white","className":"is-style-fill"} -->
<div class="wp-block-button is-style-fill"><a class="wp-block-button__link has-white-color has-vivid-cyan-blue-background-color has-text-color has-background wp-element-button" href="${esc(content.cta_url)}">${esc(content.cta_text)}</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

</div></div>
<!-- /wp:cover -->`;
}

function buildProblemSolutionSection(content: AppContent): string {
  // Split problem_statement into problem and solution if possible
  const sentences = content.problem_statement.split('. ').filter(Boolean);
  const midpoint = Math.ceil(sentences.length / 2);
  const problemText = sentences.slice(0, midpoint).join('. ') + '.';
  const solutionText = sentences.length > 2
    ? sentences.slice(midpoint).join('. ') + '.'
    : `${content.app_name} solves this. ${content.tagline}`;

  return `<!-- wp:columns {"className":"appspotlight-problem-solution","style":{"spacing":{"padding":{"top":"3rem","bottom":"3rem","left":"2rem","right":"2rem"}}}} -->
<div class="wp-block-columns appspotlight-problem-solution" style="padding-top:3rem;padding-right:2rem;padding-bottom:3rem;padding-left:2rem">

<!-- wp:column {"backgroundColor":"black","style":{"border":{"radius":"16px"},"spacing":{"padding":{"top":"2.5rem","right":"2.5rem","bottom":"2.5rem","left":"2.5rem"}}}} -->
<div class="wp-block-column has-black-background-color has-background" style="border-radius:16px;padding-top:2.5rem;padding-right:2.5rem;padding-bottom:2.5rem;padding-left:2.5rem">

<!-- wp:paragraph {"style":{"typography":{"fontSize":"0.75rem","fontWeight":"700","textTransform":"uppercase","letterSpacing":"0.15em"}},"textColor":"vivid-red"} -->
<p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.15em">The Problem</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"cyan-bluish-gray"} -->
<p>${esc(problemText)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

<!-- wp:column {"backgroundColor":"black","style":{"border":{"radius":"16px"},"spacing":{"padding":{"top":"2.5rem","right":"2.5rem","bottom":"2.5rem","left":"2.5rem"}}}} -->
<div class="wp-block-column has-black-background-color has-background" style="border-radius:16px;padding-top:2.5rem;padding-right:2.5rem;padding-bottom:2.5rem;padding-left:2.5rem">

<!-- wp:paragraph {"style":{"typography":{"fontSize":"0.75rem","fontWeight":"700","textTransform":"uppercase","letterSpacing":"0.15em"}},"textColor":"vivid-green-cyan"} -->
<p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.15em">The Solution</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"cyan-bluish-gray"} -->
<p>${esc(solutionText)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

</div>
<!-- /wp:columns -->`;
}

function buildFeaturesSection(content: AppContent): string {
  const featureBlocks = content.features.slice(0, 4).map((feature, i) => {
    const icon = feature.icon ?? FEATURE_ICONS[i % FEATURE_ICONS.length];
    return `<!-- wp:column {"backgroundColor":"black","style":{"border":{"radius":"16px"},"spacing":{"padding":{"top":"2rem","right":"2rem","bottom":"2rem","left":"2rem"}}}} -->
<div class="wp-block-column has-black-background-color has-background" style="border-radius:16px;padding-top:2rem;padding-right:2rem;padding-bottom:2rem;padding-left:2rem">

<!-- wp:paragraph {"style":{"typography":{"fontSize":"2rem"}}} -->
<p style="font-size:2rem">${icon}</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":3,"style":{"typography":{"fontSize":"1.1rem","fontWeight":"700"}},"textColor":"white"} -->
<h3 class="wp-block-heading has-white-color has-text-color" style="font-size:1.1rem;font-weight:700">${esc(feature.title)}</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"cyan-bluish-gray","style":{"typography":{"fontSize":"0.95rem"}}} -->
<p style="font-size:0.95rem">${esc(feature.description)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->`;
  });

  // Split into rows of 2
  const rows: string[] = [];
  for (let i = 0; i < featureBlocks.length; i += 2) {
    const cols = featureBlocks.slice(i, i + 2).join('\n\n');
    rows.push(`<!-- wp:columns -->
<div class="wp-block-columns">
${cols}
</div>
<!-- /wp:columns -->`);
  }

  return `<!-- wp:group {"className":"appspotlight-features","backgroundColor":"black","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"}}}} -->
<div class="wp-block-group appspotlight-features has-black-background-color has-background" style="padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"}},"textColor":"white"} -->
<h2 class="wp-block-heading has-text-align-center has-white-color has-text-color" style="font-size:2.2rem;font-weight:800">What It Does</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"2rem"} -->
<div style="height:2rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

${rows.join('\n\n')}

</div>
<!-- /wp:group -->`;
}

function buildGallerySection(mediaResults: WPMediaResult[]): string {
  const imageBlocks = mediaResults.map(m =>
    `<!-- wp:image {"id":${m.mediaId},"sizeSlug":"large","linkDestination":"none"} -->
<figure class="wp-block-image size-large"><img src="${esc(m.sourceUrl)}" alt="" class="wp-image-${m.mediaId}"/></figure>
<!-- /wp:image -->`
  ).join('\n\n');

  return `<!-- wp:group {"className":"appspotlight-gallery","backgroundColor":"black","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"}}}} -->
<div class="wp-block-group appspotlight-gallery has-black-background-color has-background" style="padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"}},"textColor":"white"} -->
<h2 class="wp-block-heading has-text-align-center has-white-color has-text-color" style="font-size:2.2rem;font-weight:800">See It In Action</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"2rem"} -->
<div style="height:2rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:gallery {"columns":${Math.min(mediaResults.length, 3)},"linkTo":"none","className":"appspotlight-screenshots"} -->
<figure class="wp-block-gallery has-nested-images columns-${Math.min(mediaResults.length, 3)} appspotlight-screenshots">
${imageBlocks}
</figure>
<!-- /wp:gallery -->

</div>
<!-- /wp:group -->`;
}

function buildAudienceSection(content: AppContent): string {
  const audienceSegments = parseAudience(content.target_audience);
  const emojis = ['🎯', '👥', '🏢'];

  const cards = audienceSegments.map((segment, i) =>
    `<!-- wp:column {"backgroundColor":"black","style":{"border":{"radius":"16px"},"spacing":{"padding":{"top":"2rem","right":"2rem","bottom":"2rem","left":"2rem"}}}} -->
<div class="wp-block-column has-black-background-color has-background" style="border-radius:16px;padding-top:2rem;padding-right:2rem;padding-bottom:2rem;padding-left:2rem">

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"2.5rem"}}} -->
<p class="has-text-align-center" style="font-size:2.5rem">${emojis[i % emojis.length]}</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"align":"center","textColor":"cyan-bluish-gray"} -->
<p class="has-text-align-center">${esc(segment)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->`
  ).join('\n\n');

  return `<!-- wp:group {"className":"appspotlight-audience","backgroundColor":"black","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"}}}} -->
<div class="wp-block-group appspotlight-audience has-black-background-color has-background" style="padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"}},"textColor":"white"} -->
<h2 class="wp-block-heading has-text-align-center has-white-color has-text-color" style="font-size:2.2rem;font-weight:800">Who It's For</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"2rem"} -->
<div style="height:2rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:columns -->
<div class="wp-block-columns">
${cards}
</div>
<!-- /wp:columns -->

</div>
<!-- /wp:group -->`;
}

function buildTechStackSection(content: AppContent): string {
  const badges = content.tech_stack.map(tech =>
    `<span style="display:inline-block;background:#1e2440;border:1px solid rgba(255,255,255,0.15);border-radius:100px;padding:8px 18px;margin:4px;font-size:0.85rem;color:#d1d5e8;font-family:sans-serif">${esc(tech)}</span>`
  ).join('');

  return `<!-- wp:group {"className":"appspotlight-tech-stack","backgroundColor":"black","style":{"spacing":{"padding":{"top":"2rem","bottom":"4rem","left":"2rem","right":"2rem"}}}} -->
<div class="wp-block-group appspotlight-tech-stack has-black-background-color has-background" style="padding-top:2rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"0.8rem","fontWeight":"600","textTransform":"uppercase","letterSpacing":"0.15em"}},"textColor":"cyan-bluish-gray"} -->
<p class="has-text-align-center" style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.15em">Built With</p>
<!-- /wp:paragraph -->

<!-- wp:html -->
<div style="text-align:center;padding:0 20px">${badges}</div>
<!-- /wp:html -->

</div>
<!-- /wp:group -->`;
}

function buildCtaSection(content: AppContent): string {
  return `<!-- wp:cover {"dimRatio":90,"overlayColor":"black","isDark":true,"className":"appspotlight-cta"} -->
<div class="wp-block-cover is-dark appspotlight-cta"><span aria-hidden="true" class="wp-block-cover__background has-black-background-color has-background-dim-90 has-background-dim"></span><div class="wp-block-cover__inner-container">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.5rem","fontWeight":"800"}},"textColor":"white"} -->
<h2 class="wp-block-heading has-text-align-center has-white-color has-text-color" style="font-size:2.5rem;font-weight:800">Ready to check it out?</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","textColor":"cyan-bluish-gray","style":{"typography":{"fontSize":"1.1rem"}}} -->
<p class="has-text-align-center" style="font-size:1.1rem">${esc(content.tagline)}</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"vivid-cyan-blue","textColor":"white"} -->
<div class="wp-block-button"><a class="wp-block-button__link has-white-color has-vivid-cyan-blue-background-color has-text-color has-background wp-element-button" href="${esc(content.cta_url)}">${esc(content.cta_text)}</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/contact">Talk to Ziv</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

</div></div>
<!-- /wp:cover -->`;
}

function buildFooterBadge(repoName: string, confidence: number): string {
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const badge = confidence >= 90 ? '' : ' · ⚠️ Review Suggested';

  return `<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"0.75rem"},"spacing":{"padding":{"top":"1rem","bottom":"1rem"}}},"textColor":"cyan-bluish-gray","className":"appspotlight-badge"} -->
<p class="has-text-align-center has-cyan-bluish-gray-color has-text-color appspotlight-badge" style="font-size:0.75rem;padding-top:1rem;padding-bottom:1rem">This page was auto-generated by <strong>AppSpotlight</strong> · Last updated ${date}${badge}</p>
<!-- /wp:paragraph -->`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAudience(audienceStr: string): string[] {
  // Try to split on common delimiters
  const segments = audienceStr
    .split(/[,;]|\band\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 5);

  if (segments.length >= 2) return segments.slice(0, 3);

  // Fallback: just use the whole string
  return [audienceStr];
}
