import type { AppContent, WPMediaResult, ProjectType } from '@appspotlight/shared';
import { isNonWebProject } from '@appspotlight/shared';

/**
 * Generates Gutenberg block markup for AppSpotlight portfolio pages.
 *
 * All sections use wp:group (NOT wp:cover) with explicit inline background-color:#000
 * to prevent WordPress themes (especially Divi) from injecting white backgrounds
 * or blue highlights.
 *
 * Sections:
 * 1. Hero (group with heading, tagline, CTA button)
 * 2. Problem / Solution (two-column layout)
 * 3. Feature Cards (2-col grid with hover effects)
 * 4. Screenshot Gallery (columns with full-size images)
 * 5. The Tech Stack (badges with hover effects)
 * 6. Who It's For (audience cards)
 * 7. CTA Section (heading, tagline, buttons)
 */

const FEATURE_ICONS = ['⚡', '🤖', '📊', '🎯', '🔧', '🚀', '💡', '🔒'];

export function generatePageMarkup(
  content: AppContent,
  mediaResults: WPMediaResult[],
  repoName: string,
  confidence: number,
  repoUrl?: string,
  projectType?: ProjectType
): string {
  const blocks: string[] = [];

  // Inject global CSS for hover effects (wp:html block at top)
  blocks.push(buildGlobalStyles());

  // 1. Hero Section
  blocks.push(buildHeroSection(content));

  // 2. Problem / Solution
  blocks.push(buildProblemSolutionSection(content));

  // 3. Features
  blocks.push(buildFeaturesSection(content));

  // 4. Screenshot Gallery
  if (mediaResults.length > 0) {
    const galleryHeading = projectType && isNonWebProject(projectType)
      ? 'Project Overview'
      : 'See It In Action';
    blocks.push(buildGallerySection(mediaResults, galleryHeading));
  }

  // 5. The Tech Stack
  blocks.push(buildTechStackSection(content));

  // 6. Who It's For
  blocks.push(buildAudienceSection(content));

  // 7. CTA Section
  blocks.push(buildCtaSection(content, repoUrl));

  // Lightbox markup + script (only if gallery exists)
  if (mediaResults.length > 0) {
    blocks.push(buildLightboxScript());
  }

  const innerContent = blocks.join('\n\n');

  // Wrap everything in a dark background group — explicit inline styles to override theme
  return `<!-- wp:group {"backgroundColor":"black","style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"},"margin":{"top":"0","bottom":"0"},"blockGap":"0"},"color":{"background":"#000000"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group has-black-background-color has-background" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0">

${innerContent}

</div>
<!-- /wp:group -->`;
}

// ─── Global Styles (hover effects) ────────────────────────────────────────

function buildGlobalStyles(): string {
  return `<!-- wp:html -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&family=Open+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* Force black background — only content area, preserve header/nav */
  #main-content, #left-area,
  #content-area, .et_builder_inner_content,
  #main-content article, #main-content .entry-content,
  #main-content .et_pb_post_content,
  #main-content .container,
  #main-content .et_pb_row {
    background-color: #000 !important;
  }
  /* Hide sidebar — our pages are full-width */
  #sidebar, .et_right_sidebar #sidebar,
  #main-content .container:after {
    display: none !important;
  }
  /* Force CONTENT to full width (scoped to #main-content, not nav) */
  #left-area, .et_right_sidebar #left-area,
  .et_no_sidebar #left-area {
    width: 100% !important;
    max-width: 100% !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    float: none !important;
  }
  #main-content .container {
    width: 100% !important;
    max-width: 100% !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  /* Hide WordPress/Divi page title — our hero section has its own */
  .entry-title, .page-title,
  .et_pb_post_title, .et_post_meta_wrapper,
  article > header, .entry-header {
    display: none !important;
  }
  /* Remove any top padding/margin the theme adds above content */
  .entry-content, .et_pb_post_content,
  #main-content .container {
    padding-top: 0 !important;
    margin-top: 0 !important;
  }
  /* Font standards — match homepage (Poppins headings, Open Sans body, min 18px) */
  /* NEVER use Arial or system fonts — only Poppins + Open Sans from Google Fonts */
  .entry-content h1, .entry-content h2, .entry-content h3 {
    font-family: 'Poppins', 'Open Sans', sans-serif !important;
  }
  .entry-content p, .entry-content li, .entry-content span {
    font-family: 'Open Sans', 'Poppins', sans-serif !important;
  }
  /* Min 18px for body text, but exclude small labels and icon paragraphs */
  .entry-content p {
    font-size: max(18px, 1em) !important;
    line-height: 1.7 !important;
  }
  .entry-content p[style*="text-transform:uppercase"] {
    font-size: inherit !important;
  }
  /* Emoji icon spans — render at their inline font-size, not the p's min-18px */
  .appspotlight-icon {
    font-size: inherit;
    line-height: 1;
  }
  /* Problem/Solution card hover */
  .appspotlight-ps-card {
    transition: transform 0.25s ease, box-shadow 0.25s ease;
  }
  .appspotlight-ps-card:hover {
    transform: translateY(-6px);
    box-shadow: 0 12px 32px rgba(0, 120, 255, 0.15);
  }
  /* Feature card hover */
  .appspotlight-feature-card {
    transition: transform 0.25s ease, box-shadow 0.25s ease;
  }
  .appspotlight-feature-card:hover {
    transform: translateY(-6px);
    box-shadow: 0 12px 32px rgba(0, 120, 255, 0.15);
  }
  /* Feature icon bounce on card hover */
  .appspotlight-feature-card .appspotlight-icon {
    display: inline-block;
    transition: transform 0.3s ease;
  }
  .appspotlight-feature-card:hover .appspotlight-icon {
    transform: scale(1.25) rotate(-5deg);
  }
  /* Tech badge hover */
  .appspotlight-badge-item {
    transition: transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    cursor: default;
  }
  .appspotlight-badge-item:hover {
    transform: translateY(-3px) scale(1.05);
    background: #2a3560 !important;
    box-shadow: 0 6px 20px rgba(0, 120, 255, 0.2);
  }
  /* Audience card hover */
  .appspotlight-audience-card {
    transition: transform 0.25s ease, box-shadow 0.25s ease;
  }
  .appspotlight-audience-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 24px rgba(0, 120, 255, 0.12);
  }
  /* Kill any theme-injected gaps between sections — prevents white lines between dark blocks */
  .entry-content > .wp-block-group > .wp-block-group {
    margin-top: 0 !important;
    margin-bottom: 0 !important;
  }
  .entry-content > .wp-block-group {
    gap: 0 !important;
  }
  /* Gallery — force Gutenberg columns/images to render in Divi */
  .appspotlight-gallery .wp-block-columns {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 1.5rem !important;
    width: 100% !important;
  }
  .appspotlight-gallery .wp-block-column {
    flex: 1 1 0 !important;
    min-width: 250px !important;
  }
  .appspotlight-gallery .wp-block-image {
    margin: 0 !important;
  }
  .appspotlight-gallery .wp-block-image img {
    display: block !important;
    width: 100% !important;
    height: auto !important;
    border-radius: 12px !important;
  }
  /* Gallery images — clickable cursor */
  .appspotlight-gallery .wp-block-image img {
    cursor: pointer;
  }
  /* Lightbox overlay */
  .appspotlight-lightbox {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 999999;
    background: rgba(0, 0, 0, 0.92);
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
    padding: 2rem;
  }
  .appspotlight-lightbox.active {
    display: flex;
  }
  .appspotlight-lightbox img {
    max-width: 90vw;
    max-height: 90vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 0 60px rgba(0, 120, 255, 0.3);
  }
  .appspotlight-lightbox-close {
    position: absolute;
    top: 1.5rem;
    right: 2rem;
    color: #fff;
    font-size: 2rem;
    cursor: pointer;
    background: none;
    border: none;
    opacity: 0.7;
    transition: opacity 0.2s;
    z-index: 1000000;
  }
  .appspotlight-lightbox-close:hover {
    opacity: 1;
  }
  /* Kill stray empty elements — scoped to content area only, never affect header/nav */
  .entry-content > div:empty,
  .entry-content input:not([type="submit"]),
  .entry-content textarea,
  .entry-content iframe:not([src*="youtube"]):not([src*="vimeo"]),
  #main-content .et_pb_section--absolute,
  #main-content .et_pb_module:empty {
    display: none !important;
    visibility: hidden !important;
    width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
  }
  /* Protect Divi header/nav — ensure readable menu items on dark background */
  #main-header,
  #main-header .et_pb_menu__menu,
  #main-header .et_pb_menu__menu nav,
  .et-l--header {
    visibility: visible !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
  }
  #main-header a,
  #main-header .et_pb_menu__menu a,
  .et-l--header a {
    color: #fff !important;
    visibility: visible !important;
  }
  /* Mobile hamburger icon — ensure visible */
  .mobile_menu_bar:before,
  .et_pb_menu__icon {
    color: #fff !important;
    visibility: visible !important;
  }
  /* All buttons — base transition */
  .entry-content .wp-block-button__link {
    transition: box-shadow 0.25s ease, transform 0.25s ease, background-color 0.25s ease, color 0.25s ease !important;
  }
  /* Filled buttons — glow + lift on hover */
  .entry-content .wp-block-button:not(.is-style-outline) .wp-block-button__link:hover {
    box-shadow: 0 8px 25px rgba(0, 120, 255, 0.4) !important;
    transform: translateY(-3px) !important;
    filter: brightness(1.1);
  }
  /* Outline buttons — fill in on hover */
  .entry-content .wp-block-button.is-style-outline .wp-block-button__link:hover {
    background-color: rgba(171, 184, 195, 0.15) !important;
    box-shadow: 0 6px 20px rgba(171, 184, 195, 0.2) !important;
    transform: translateY(-2px) !important;
  }
  /* ── Responsive: Tablet (≤1024px) ── */
  @media (max-width: 1024px) {
    .appspotlight-hero {
      padding-top: 4rem !important;
      padding-bottom: 2.5rem !important;
    }
  }
  /* ── Responsive: Mobile (≤767px) ── */
  @media (max-width: 767px) {
    .appspotlight-hero {
      padding-top: 3.5rem !important;
      padding-bottom: 1.5rem !important;
      padding-left: 1.25rem !important;
      padding-right: 1.25rem !important;
    }
    .appspotlight-features,
    .appspotlight-gallery,
    .appspotlight-tech-stack,
    .appspotlight-audience,
    .appspotlight-cta-section {
      padding-top: 2.5rem !important;
      padding-bottom: 2.5rem !important;
      padding-left: 1.25rem !important;
      padding-right: 1.25rem !important;
    }
    .appspotlight-problem-solution {
      padding-top: 2rem !important;
      padding-bottom: 2rem !important;
      padding-left: 1.25rem !important;
      padding-right: 1.25rem !important;
    }
    /* Force columns to stack vertically on mobile */
    .appspotlight-problem-solution.wp-block-columns,
    .appspotlight-features .wp-block-columns,
    .appspotlight-audience .wp-block-columns,
    .appspotlight-gallery .wp-block-columns {
      flex-direction: column !important;
    }
    .appspotlight-gallery .wp-block-column {
      min-width: 100% !important;
      flex-basis: 100% !important;
    }
    /* Cards — reduce padding on mobile */
    .appspotlight-feature-card,
    .appspotlight-ps-card,
    .appspotlight-audience-card {
      padding: 1.5rem !important;
    }
    .appspotlight-cta-section {
      padding-bottom: 3rem !important;
    }
    /* Tech badges — smaller on mobile */
    .appspotlight-badge-item {
      padding: 8px 16px !important;
      font-size: 0.9rem !important;
    }
  }
</style>
<!-- /wp:html -->`;
}

// ─── Section Builders ───────────────────────────────────────────────────────

function buildHeroSection(content: AppContent): string {
  // Use wp:group (NOT wp:cover) — cover blocks render badly with Divi theme
  return `<!-- wp:group {"className":"appspotlight-hero","style":{"spacing":{"padding":{"top":"6rem","bottom":"3rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-hero" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:6rem;padding-right:2rem;padding-bottom:3rem;padding-left:2rem">

<!-- wp:heading {"level":1,"style":{"typography":{"fontSize":"3.5rem","fontWeight":"900","lineHeight":"1.1"},"color":{"text":"#ffffff"}}} -->
<h1 class="wp-block-heading" style="color:#fff;font-size:clamp(1.8rem,7vw,3.5rem);font-weight:900;line-height:1.1">${esc(content.app_name)}</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"1.3rem","lineHeight":"1.6"},"color":{"text":"#abb8c3"}}} -->
<p style="color:#abb8c3;font-size:clamp(1rem,3vw,1.3rem);line-height:1.6">${esc(content.tagline)}</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"left"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"vivid-cyan-blue","style":{"color":{"text":"#ffffff"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-vivid-cyan-blue-background-color has-background wp-element-button" style="color:#fff" href="${esc(content.cta_url)}">${esc(content.cta_text)}</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

</div>
<!-- /wp:group -->`;
}

function buildProblemSolutionSection(content: AppContent): string {
  const sentences = content.problem_statement.split('. ').filter(Boolean);
  const midpoint = Math.ceil(sentences.length / 2);
  const problemText = sentences.slice(0, midpoint).join('. ') + '.';
  const solutionText = sentences.length > 2
    ? sentences.slice(midpoint).join('. ') + '.'
    : `${content.app_name} solves this. ${content.tagline}`;

  return `<!-- wp:group {"style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group" style="background-color:#000;margin-top:0;margin-bottom:0;padding:0">

<!-- wp:columns {"className":"appspotlight-problem-solution","style":{"spacing":{"padding":{"top":"3rem","bottom":"3rem","left":"2rem","right":"2rem"},"blockGap":{"left":"1.5rem"}}}} -->
<div class="wp-block-columns appspotlight-problem-solution" style="padding-top:3rem;padding-right:2rem;padding-bottom:3rem;padding-left:2rem">

<!-- wp:column {"className":"appspotlight-ps-card","style":{"color":{"background":"#1a1a2e"},"border":{"radius":"16px"},"spacing":{"padding":{"top":"2.5rem","right":"2.5rem","bottom":"2.5rem","left":"2.5rem"}}}} -->
<div class="wp-block-column appspotlight-ps-card" style="background-color:#1a1a2e;border-radius:16px;padding-top:2.5rem;padding-right:2.5rem;padding-bottom:2.5rem;padding-left:2.5rem">

<!-- wp:paragraph {"style":{"typography":{"fontSize":"0.85rem","fontWeight":"700","textTransform":"uppercase","letterSpacing":"0.15em"},"color":{"text":"#ff6b6b"}}} -->
<p style="color:#ff6b6b;font-size:0.85rem;font-weight:700;text-transform:uppercase;letter-spacing:0.15em">The Problem</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"color":{"text":"#abb8c3"}}} -->
<p style="color:#abb8c3">${esc(problemText)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

<!-- wp:column {"className":"appspotlight-ps-card","style":{"color":{"background":"#1a1a2e"},"border":{"radius":"16px"},"spacing":{"padding":{"top":"2.5rem","right":"2.5rem","bottom":"2.5rem","left":"2.5rem"}}}} -->
<div class="wp-block-column appspotlight-ps-card" style="background-color:#1a1a2e;border-radius:16px;padding-top:2.5rem;padding-right:2.5rem;padding-bottom:2.5rem;padding-left:2.5rem">

<!-- wp:paragraph {"style":{"typography":{"fontSize":"0.85rem","fontWeight":"700","textTransform":"uppercase","letterSpacing":"0.15em"},"color":{"text":"#51cf66"}}} -->
<p style="color:#51cf66;font-size:0.85rem;font-weight:700;text-transform:uppercase;letter-spacing:0.15em">The Solution</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"style":{"color":{"text":"#abb8c3"}}} -->
<p style="color:#abb8c3">${esc(solutionText)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->

</div>
<!-- /wp:columns -->

</div>
<!-- /wp:group -->`;
}

function buildFeaturesSection(content: AppContent): string {
  const featureBlocks = content.features.slice(0, 8).map((feature, i) => {
    const icon = feature.icon ?? FEATURE_ICONS[i % FEATURE_ICONS.length];
    return `<!-- wp:column {"className":"appspotlight-feature-card","style":{"color":{"background":"#1a1a2e"},"border":{"radius":"16px"},"spacing":{"padding":{"top":"2rem","right":"2rem","bottom":"2rem","left":"2rem"}}}} -->
<div class="wp-block-column appspotlight-feature-card" style="background-color:#1a1a2e;border-radius:16px;padding-top:2rem;padding-right:2rem;padding-bottom:2rem;padding-left:2rem">

<!-- wp:paragraph {"style":{"typography":{"fontSize":"4.5rem"}}} -->
<p style="font-size:2.7rem"><span class="appspotlight-icon" style="font-size:2.7rem;line-height:1">${icon}</span></p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":3,"style":{"typography":{"fontSize":"1.1rem","fontWeight":"700"},"color":{"text":"#ffffff"}}} -->
<h3 class="wp-block-heading" style="color:#fff;font-size:1.1rem;font-weight:700">${esc(feature.title)}</h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"style":{"typography":{"fontSize":"0.95rem"},"color":{"text":"#abb8c3"}}} -->
<p style="color:#abb8c3;font-size:0.95rem">${esc(feature.description)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:column -->`;
  });

  // Split into rows of 2, with spacers between rows for vertical gap
  const rows: string[] = [];
  for (let i = 0; i < featureBlocks.length; i += 2) {
    const cols = featureBlocks.slice(i, i + 2).join('\n\n');
    if (rows.length > 0) {
      rows.push(`<!-- wp:spacer {"height":"1.5rem"} -->
<div style="height:1.5rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->`);
    }
    rows.push(`<!-- wp:columns {"style":{"spacing":{"blockGap":{"left":"1.5rem"}}}} -->
<div class="wp-block-columns">
${cols}
</div>
<!-- /wp:columns -->`);
  }

  return `<!-- wp:group {"className":"appspotlight-features","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-features" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"},"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#fff;font-size:clamp(1.5rem,5vw,2.2rem);font-weight:800">What It Does</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"2rem"} -->
<div style="height:2rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

${rows.join('\n\n')}

</div>
<!-- /wp:group -->`;
}

const GALLERY_ROW_SPACER = `<!-- wp:spacer {"height":"1.5rem"} -->
<div style="height:1.5rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->`;

function buildGallerySection(mediaResults: WPMediaResult[], heading: string = 'See It In Action'): string {
  const maxCols = Math.min(mediaResults.length, 3);
  const rows: string[] = [];

  for (let i = 0; i < mediaResults.length; i += maxCols) {
    const rowItems = mediaResults.slice(i, i + maxCols);
    const rowColCount = rowItems.length;

    const cols = rowItems.map(m =>
      `<!-- wp:column -->
<div class="wp-block-column">
<!-- wp:image {"id":${m.mediaId},"sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"12px"}}} -->
<figure class="wp-block-image size-full has-custom-border"><img src="${esc(m.sourceUrl)}" alt="App screenshot" class="wp-image-${m.mediaId}" style="border-radius:12px;width:100%"/></figure>
<!-- /wp:image -->
</div>
<!-- /wp:column -->`
    ).join('\n\n');

    const columnsAttr = rowColCount < maxCols
      ? `{"columns":${rowColCount},"style":{"spacing":{"blockGap":{"left":"1.5rem"}}}}`
      : `{"style":{"spacing":{"blockGap":{"left":"1.5rem"}}}}`;

    rows.push(`<!-- wp:columns ${columnsAttr} -->
<div class="wp-block-columns">
${cols}
</div>
<!-- /wp:columns -->`);
  }

  return `<!-- wp:group {"className":"appspotlight-gallery","style":{"spacing":{"padding":{"top":"4rem","bottom":"2rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"},"blockGap":"1.5rem"},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-gallery" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:4rem;padding-right:2rem;padding-bottom:2rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"},"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#fff;font-size:clamp(1.5rem,5vw,2.2rem);font-weight:800">${esc(heading)}</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"1rem"} -->
<div style="height:1rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

${rows.join(`\n\n${GALLERY_ROW_SPACER}\n\n`)}

</div>
<!-- /wp:group -->`;
}

function buildTechStackSection(content: AppContent): string {
  const badges = content.tech_stack.map(tech =>
    `<span class="appspotlight-badge-item" style="display:inline-block;background:#1e2440;border:1px solid rgba(255,255,255,0.15);border-radius:100px;padding:12px 24px;margin:6px;font-size:1.05rem;color:#d1d5e8;font-family:'Open Sans','Poppins',sans-serif;letter-spacing:0.02em">${esc(tech)}</span>`
  ).join('');

  return `<!-- wp:group {"className":"appspotlight-tech-stack","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-tech-stack" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"},"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#fff;font-size:clamp(1.5rem,5vw,2.2rem);font-weight:800">The Tech Stack</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"1.5rem"} -->
<div style="height:1.5rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:html -->
<div style="text-align:center;padding:0 20px;max-width:800px;margin:0 auto">${badges}</div>
<!-- /wp:html -->

</div>
<!-- /wp:group -->`;
}

function buildAudienceSection(content: AppContent): string {
  const audienceSegments = parseAudience(content.target_audience);
  const emojis = ['🎯', '👥', '🏢'];

  // If only 1 short segment with no benefit, render as a simple centered paragraph
  if (audienceSegments.length === 1 && !audienceSegments[0].benefit && audienceSegments[0].persona.length < 30) {
    return `<!-- wp:group {"className":"appspotlight-audience","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-audience" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"},"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#fff;font-size:clamp(1.5rem,5vw,2.2rem);font-weight:800">Who It's For</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"1rem"} -->
<div style="height:1rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"1.3rem"},"color":{"text":"#abb8c3"}}} -->
<p class="has-text-align-center" style="color:#abb8c3;font-size:clamp(1rem,3vw,1.3rem)">${emojis[0]} ${esc(audienceSegments[0].persona)}</p>
<!-- /wp:paragraph -->

</div>
<!-- /wp:group -->`;
  }

  const cards = audienceSegments.map((segment, i) => {
    const benefitBlock = segment.benefit
      ? `\n<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"1.05rem"},"color":{"text":"#d1d5e8"},"spacing":{"margin":{"top":"0.5rem"}}}} -->
<p class="has-text-align-center" style="color:#d1d5e8;font-size:1.05rem;margin-top:0.5rem">${esc(segment.benefit)}</p>
<!-- /wp:paragraph -->`
      : '';

    return `<!-- wp:column {"className":"appspotlight-audience-card","style":{"color":{"background":"#1a1a2e"},"border":{"radius":"16px"},"spacing":{"padding":{"top":"2rem","right":"2rem","bottom":"2rem","left":"2rem"}}}} -->
<div class="wp-block-column appspotlight-audience-card" style="background-color:#1a1a2e;border-radius:16px;padding-top:2rem;padding-right:2rem;padding-bottom:2rem;padding-left:2rem">

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"5.5rem"}}} -->
<p class="has-text-align-center" style="font-size:3.3rem"><span class="appspotlight-icon" style="font-size:3.3rem;line-height:1">${emojis[i % emojis.length]}</span></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontWeight":"600"},"color":{"text":"#ffffff"}}} -->
<p class="has-text-align-center" style="color:#fff;font-weight:600">${esc(segment.persona)}</p>
<!-- /wp:paragraph -->
${benefitBlock}
</div>
<!-- /wp:column -->`;
  }).join('\n\n');

  return `<!-- wp:group {"className":"appspotlight-audience","style":{"spacing":{"padding":{"top":"4rem","bottom":"4rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-audience" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:4rem;padding-right:2rem;padding-bottom:4rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.2rem","fontWeight":"800"},"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#fff;font-size:clamp(1.5rem,5vw,2.2rem);font-weight:800">Who It's For</h2>
<!-- /wp:heading -->

<!-- wp:spacer {"height":"2rem"} -->
<div style="height:2rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:columns {"style":{"spacing":{"blockGap":{"left":"1.5rem"}}}} -->
<div class="wp-block-columns">
${cards}
</div>
<!-- /wp:columns -->

</div>
<!-- /wp:group -->`;
}

function buildCtaSection(content: AppContent, repoUrl?: string): string {
  // GitHub button — only show if we have a repo URL
  const githubButton = repoUrl
    ? `\n<!-- wp:button {"className":"is-style-outline","style":{"color":{"text":"#abb8c3"}}} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" style="color:#abb8c3" href="${esc(repoUrl.replace(/\.git$/, ''))}">View on GitHub</a></div>
<!-- /wp:button -->`
    : '';

  // Use wp:group (NOT wp:cover) for Divi compatibility
  return `<!-- wp:group {"className":"appspotlight-cta-section","style":{"spacing":{"padding":{"top":"2rem","bottom":"5rem","left":"2rem","right":"2rem"},"margin":{"top":"0","bottom":"0"}},"color":{"background":"#000000"}}} -->
<div class="wp-block-group appspotlight-cta-section" style="background-color:#000;margin-top:0;margin-bottom:0;padding-top:2rem;padding-right:2rem;padding-bottom:5rem;padding-left:2rem">

<!-- wp:heading {"textAlign":"center","style":{"typography":{"fontSize":"2.5rem","fontWeight":"800"},"color":{"text":"#ffffff"}}} -->
<h2 class="wp-block-heading has-text-align-center" style="color:#fff;font-size:clamp(1.6rem,5vw,2.5rem);font-weight:800">Ready to check it out?</h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"typography":{"fontSize":"1.1rem"},"color":{"text":"#abb8c3"}}} -->
<p class="has-text-align-center" style="color:#abb8c3;font-size:1.1rem">${esc(content.tagline)}</p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"1rem"} -->
<div style="height:1rem" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"vivid-cyan-blue","style":{"color":{"text":"#ffffff"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-vivid-cyan-blue-background-color has-background wp-element-button" style="color:#fff" href="${esc(content.cta_url)}">${esc(content.cta_text)}</a></div>
<!-- /wp:button -->
${githubButton}
<!-- wp:button {"className":"is-style-outline","style":{"color":{"text":"#abb8c3"}}} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" style="color:#abb8c3" href="/contact">Talk to Ziv</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

</div>
<!-- /wp:group -->`;
}

function buildLightboxScript(): string {
  return `<!-- wp:html -->
<div class="appspotlight-lightbox" id="appspotlight-lightbox">
  <button class="appspotlight-lightbox-close" aria-label="Close">&times;</button>
  <img src="" alt="Enlarged screenshot" />
</div>
<script>
(function() {
  var lb = document.getElementById('appspotlight-lightbox');
  if (!lb) return;
  var lbImg = lb.querySelector('img');
  var gallery = document.querySelector('.appspotlight-gallery');
  if (!gallery) return;
  gallery.addEventListener('click', function(e) {
    var img = e.target;
    if (img.tagName !== 'IMG') return;
    var src = img.getAttribute('data-lazy-src') || img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    lbImg.src = src;
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
  });
  lb.addEventListener('click', function() {
    lb.classList.remove('active');
    document.body.style.overflow = '';
    lbImg.src = '';
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && lb.classList.contains('active')) {
      lb.classList.remove('active');
      document.body.style.overflow = '';
      lbImg.src = '';
    }
  });
})();
</script>
<!-- /wp:html -->`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Capitalize first letter of a string. */
function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

interface AudienceSegment {
  persona: string;
  benefit: string | null;
}

/**
 * If persona is too long (>30 chars), split it into a short headline
 * and move the rest into the benefit. Looks for natural break points
 * like participles ("launching", "looking") or relative pronouns ("who", "that").
 */
function shortenPersona(segment: AudienceSegment): AudienceSegment {
  if (segment.persona.length <= 30) return segment;

  // Try to split at a natural break word
  const breakPattern = /^(.+?)\s+(who|that|which|launching|looking|wanting|needing|tired|handing|building|using|working|trying|struggling|managing|seeking|running|dealing|creating|making|developing)\b\s*(.*)/i;
  const match = segment.persona.match(breakPattern);
  if (match) {
    const shortPersona = capitalize(match[1].trim());
    const extracted = capitalize((match[2] + ' ' + match[3]).trim());
    const benefit = segment.benefit
      ? extracted + '. ' + segment.benefit
      : extracted || null;
    return { persona: shortPersona, benefit };
  }

  // Fallback: truncate at ~30 chars on word boundary
  const words = segment.persona.split(' ');
  let short = '';
  for (const w of words) {
    if ((short + ' ' + w).trim().length > 30) break;
    short = (short + ' ' + w).trim();
  }
  if (short && short !== segment.persona) {
    const rest = capitalize(segment.persona.slice(short.length).trim());
    const benefit = segment.benefit
      ? rest + '. ' + segment.benefit
      : rest || null;
    return { persona: capitalize(short), benefit };
  }

  return segment;
}

function parseAudience(audienceStr: string): AudienceSegment[] {
  let segments: AudienceSegment[] | null = null;

  // New format: "Persona: benefit | Persona: benefit"
  if (audienceStr.includes('|')) {
    const parsed = audienceStr.split('|')
      .map(s => s.trim())
      .filter(s => s.length > 2)
      .map(s => {
        const colonIdx = s.indexOf(':');
        if (colonIdx > 0) {
          return {
            persona: capitalize(s.slice(0, colonIdx).trim()),
            benefit: s.slice(colonIdx + 1).trim() || null,
          };
        }
        return { persona: capitalize(s), benefit: null };
      });
    if (parsed.length >= 2) segments = parsed.slice(0, 3);
  }

  // Legacy format: "Persona: benefit, Persona: benefit" (comma-separated with colons)
  if (!segments) {
    const commaSegments = audienceStr
      .split(/[,;]|\band\b/i)
      .map(s => s.trim())
      .filter(s => s.length > 2);

    if (commaSegments.length >= 2) {
      segments = commaSegments.slice(0, 3).map(s => {
        const colonIdx = s.indexOf(':');
        if (colonIdx > 0) {
          return {
            persona: capitalize(s.slice(0, colonIdx).trim()),
            benefit: s.slice(colonIdx + 1).trim() || null,
          };
        }
        return { persona: capitalize(s), benefit: null };
      });
    }
  }

  // Fallback: split long string into sentence-like chunks
  if (!segments && audienceStr.length > 60) {
    const sentences = audienceStr.split(/[.!]\s+/)
      .map(s => capitalize(s.trim()))
      .filter(s => s.length > 5);
    if (sentences.length >= 2) {
      segments = sentences.slice(0, 3).map(s => ({ persona: s, benefit: null }));
    }
  }

  if (!segments) {
    segments = [{ persona: capitalize(audienceStr), benefit: null }];
  }

  // Post-process: shorten any overly long persona headlines
  return segments.map(shortenPersona);
}
