#!/usr/bin/env node
/**
 * update-portfolio.ts
 * ─────────────────────────────────────────────────────────────────────
 * Regenerates the /apps/ portfolio index page (WordPress page ID 1905)
 * from all published app pages found in the Neon pipeline_runs table.
 *
 * Generates the rich "Kivi Portfolio" format with:
 *   - Category filter tabs (Agents, Games, Business, Music, Hosting, Dev Tools)
 *   - Featured project section
 *   - Animated card grid with screenshots, tech pills, and category badges
 *   - Stats bar, CTA section, footer
 *
 * Usage:
 *   npx tsx scripts/update-portfolio.ts [options]
 *
 * Options:
 *   --dry-run    Show what would be updated without making changes
 */

import { createLogger, getConfig, getDbPool } from '@appspotlight/shared';
import { findPageBySlug, updatePage, fetchChildPages } from '@appspotlight/publisher';

const log = createLogger('portfolio');

// ─── Types ──────────────────────────────────────────────────────────────────

interface AppPageInfo {
  repo_name: string;
  wp_page_url: string;
  wp_page_id: number | null;
  app_name: string;
  tagline: string;
  confidence_score: number;
  screenshot_url: string | null;
  tech_stack: string[];
}

type Category = 'agents' | 'games' | 'business' | 'music' | 'hosting' | 'devtools';

interface AppCard extends AppPageInfo {
  categories: Category[];
  emoji: string;
  subtitle: string;
  isFeatured?: boolean;
}

// ─── Category mapping per repo ──────────────────────────────────────────────

const REPO_CATEGORIES: Record<string, { categories: Category[]; emoji: string; subtitle: string }> = {
  'KaraokeMadness':               { categories: ['games'],              emoji: '🎤', subtitle: 'Karaoke Platform' },
  'ghost-hunter':                  { categories: ['games'],              emoji: '👻', subtitle: 'Arcade Game' },
  'sendtoamram':                   { categories: ['business', 'agents'], emoji: '📧', subtitle: 'Invoice Automation' },
  'choirmind':                     { categories: ['music'],              emoji: '🎵', subtitle: 'Choir App' },
  'deploy-helper':                 { categories: ['business'],           emoji: '🚀', subtitle: 'Deployment Tool' },
  'lavabowl':                      { categories: ['hosting', 'business'],emoji: '🌋', subtitle: 'Hosting Service' },
  'boards':                        { categories: ['agents', 'business'], emoji: '📋', subtitle: 'Project Management' },
  'kmshake':                       { categories: ['agents', 'business'], emoji: '📨', subtitle: 'AI Cold Outreach' },
  'appspotlight':                  { categories: ['agents'],             emoji: '🤖', subtitle: 'Portfolio Automation' },
  'seo-machine-stagesplus':        { categories: ['agents'],             emoji: '🔍', subtitle: '13-Agent SEO Pipeline' },
  'Inventory-Plus':                { categories: ['business'],           emoji: '📦', subtitle: 'Inventory Management' },
  'deployhelper-desktop-scanner':  { categories: ['devtools'],           emoji: '🔒', subtitle: 'Secret Scanner' },
  'deployhelper-scanner':          { categories: ['devtools'],           emoji: '🔐', subtitle: 'CLI Secret Scanner' },
  'rename-my-window':              { categories: ['devtools'],           emoji: '🪟', subtitle: 'VS Code Extension' },
  'carolinaHQ':                    { categories: ['business'],           emoji: '🎈', subtitle: 'Event Management' },
  'export-hats':                   { categories: ['business', 'agents'], emoji: '🎩', subtitle: 'CRM Data Export' },
};

const CATEGORY_META: Record<Category, { label: string; emoji: string; cssVar: string; color: string }> = {
  agents:   { label: 'Agents',     emoji: '🤖', cssVar: '--cat-agents',   color: '#6366F1' },
  games:    { label: 'Games',      emoji: '🎮', cssVar: '--cat-games',    color: '#EC4899' },
  business: { label: 'Business',   emoji: '💼', cssVar: '--cat-business', color: '#10B981' },
  music:    { label: 'Music',      emoji: '🎵', cssVar: '--cat-music',    color: '#F59E0B' },
  hosting:  { label: 'Hosting',    emoji: '🌋', cssVar: '--cat-hosting',  color: '#3B82F6' },
  devtools: { label: 'Dev Tools',  emoji: '🛠️', cssVar: '--cat-devtools', color: '#F97316' },
};

// ─── DB Query ───────────────────────────────────────────────────────────────

async function getPublishedApps(): Promise<AppPageInfo[]> {
  const pool = getDbPool();

  const result = await pool.query<Omit<AppPageInfo, 'screenshot_url'>>(`
    SELECT DISTINCT ON (normalized_name)
      REPLACE(repo_name, 'kivimedia/', '') as repo_name,
      wp_page_url,
      wp_page_id,
      COALESCE(generated_content->>'app_name', REPLACE(repo_name, 'kivimedia/', '')) as app_name,
      COALESCE(generated_content->>'tagline', '') as tagline,
      confidence_score,
      COALESCE(
        ARRAY(SELECT jsonb_array_elements_text(generated_content->'tech_stack')),
        ARRAY[]::text[]
      ) as tech_stack
    FROM (
      SELECT *, REPLACE(repo_name, 'kivimedia/', '') as normalized_name
      FROM pipeline_runs
      WHERE status = 'completed'
        AND wp_page_url IS NOT NULL
        AND publish_action IN ('auto_published', 'draft_approved', 'draft_edited')
    ) sub
    ORDER BY normalized_name, completed_at DESC
  `);

  // Fetch screenshots from WP page content
  const screenshotMap = await fetchScreenshotsFromWP();

  return result.rows.map(row => ({
    ...row,
    screenshot_url: screenshotMap.get(row.wp_page_id ?? 0) ?? null,
  }));
}

// ─── WP Screenshot Extraction ───────────────────────────────────────────────

function extractFirstImage(html: string): string | null {
  // Match first <img> src that looks like a screenshot (WP media or external URL with image extension)
  const imgMatch = html.match(/<img[^>]+src="([^"]+\.(webp|png|jpg|jpeg)[^"]*)"/i);
  return imgMatch?.[1] ?? null;
}

async function fetchScreenshotsFromWP(): Promise<Map<number, string>> {
  const map = new Map<number, string>();

  try {
    // Fetch all child pages of /apps/ — they return rendered content
    const childPages = await fetchChildPages('apps');
    for (const page of childPages) {
      const img = extractFirstImage(page.content);
      if (img) map.set(page.id, img);
    }

    // Also fetch top-level app pages (older apps not under /apps/)
    const config = getConfig();
    const auth = Buffer.from(`${config.wordpress.username}:${config.wordpress.appPassword}`).toString('base64');
    const topLevelSlugs = ['karaokemadness', 'deploy-helper', 'lavabowl', 'sendtoamram', 'choirmind'];
    for (const slug of topLevelSlugs) {
      try {
        const resp = await fetch(`${config.wordpress.baseUrl}/wp-json/wp/v2/pages?slug=${slug}&_fields=id,content`, {
          headers: { 'Authorization': `Basic ${auth}` },
        });
        if (resp.ok) {
          const pages = await resp.json() as Array<{ id: number; content: { rendered: string } }>;
          if (pages.length > 0) {
            const img = extractFirstImage(pages[0].content.rendered);
            if (img) map.set(pages[0].id, img);
          }
        }
      } catch { /* skip individual failures */ }
    }

    log.info(`Fetched screenshots for ${map.size} pages from WordPress`);
  } catch (err) {
    log.warn(`Failed to fetch screenshots from WP: ${(err as Error).message}`);
  }

  return map;
}

// ─── HTML Generation ────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getRepoShortName(repoName: string): string {
  return repoName.replace(/^kivimedia\//, '');
}

function getPagePath(app: AppPageInfo): string {
  // Extract path from URL, fall back to full URL
  const match = app.wp_page_url.match(/zivraviv\.com\/(.+?)$/);
  return match ? `/${match[1]}` : app.wp_page_url;
}

function buildAppCards(apps: AppCard[]): AppCard[] {
  return apps
    .filter(a => !a.isFeatured)
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));
}

function generatePortfolioContent(apps: AppCard[]): string {
  // Pick featured project (highest confidence, prefer web apps with screenshots)
  const featured = [...apps]
    .sort((a, b) => {
      const scoreA = (a.confidence_score ?? 0) + (a.screenshot_url ? 10 : 0);
      const scoreB = (b.confidence_score ?? 0) + (b.screenshot_url ? 10 : 0);
      return scoreB - scoreA;
    })[0];
  if (featured) featured.isFeatured = true;

  const gridApps = buildAppCards(apps);

  // Count categories
  const catCounts: Record<string, number> = {};
  for (const cat of Object.keys(CATEGORY_META)) catCounts[cat] = 0;
  for (const app of apps) {
    for (const cat of app.categories) catCounts[cat] = (catCounts[cat] || 0) + 1;
  }

  // Count live projects (ones with real URLs, not ?page_id=)
  const liveCount = apps.filter(a => !a.wp_page_url.includes('page_id=')).length;
  const activeCats = Object.entries(catCounts).filter(([, c]) => c > 0);

  const arrowSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;

  // ── Build filter buttons ──
  const filterButtons = [
    `<button class="filter-btn active" data-filter="all">All<span class="filter-count">${apps.length}</span></button>`,
    ...activeCats.map(([cat, count]) => {
      const meta = CATEGORY_META[cat as Category];
      return `<button class="filter-btn" data-filter="${cat}">${meta.emoji} ${meta.label}<span class="filter-count">${count}</span></button>`;
    }),
  ].join('\n      ');

  // ── Build featured card ──
  const featuredHtml = featured ? `
<section class="featured-section" id="kp-featured-section">
  <div class="kp-container">
    <div class="featured-label">Featured Project</div>
    <a href="${escHtml(getPagePath(featured))}" class="featured-card" data-categories="${featured.categories.join(' ')}">
      <div class="featured-image">
        <span class="featured-new-badge">&#x2B50; Featured</span>
        ${featured.screenshot_url
          ? `<img decoding="async" src="${escHtml(featured.screenshot_url)}" alt="${escHtml(featured.app_name)}" loading="lazy">`
          : `<div class="card-image-placeholder"><div style="text-align:center;position:relative;z-index:1;"><div style="font-size:2.5rem;margin-bottom:6px;font-weight:800;background:linear-gradient(135deg,#6366f1,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${escHtml(featured.app_name)}</div></div></div>`
        }
      </div>
      <div class="featured-content">
        <div class="card-badges">
          ${featured.categories.map(c => `<span class="cat-badge cat-${c}">${CATEGORY_META[c].label}</span>`).join('\n          ')}
        </div>
        <h2>${escHtml(featured.app_name)}</h2>
        <p class="tagline">${escHtml(featured.tagline)}</p>
        <div class="featured-meta">
          ${featured.tech_stack.slice(0, 5).map(t => `<span class="tech-pill">${escHtml(t)}</span>`).join('\n          ')}
        </div>
        <span class="featured-cta">View Project ${arrowSvg}</span>
      </div>
    </a>
  </div>
</section>` : '';

  // ── Build project cards ──
  const projectCards = gridApps.map((app, i) => {
    const catBadges = app.categories.map(c => `<span class="cat-badge cat-${c}">${CATEGORY_META[c].label}</span>`).join('\n            ');
    const techPills = app.tech_stack.slice(0, 4).map(t => `<span class="tech-pill">${escHtml(t)}</span>`).join('\n            ');
    const hasScreenshot = app.screenshot_url && !app.screenshot_url.includes('branded-card');

    const imageHtml = hasScreenshot
      ? `<div class="card-image">
          <img decoding="async" src="${escHtml(app.screenshot_url!)}" alt="${escHtml(app.app_name)}" loading="lazy">
        </div>`
      : `<div class="card-image-placeholder" style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);">
          <div style="text-align:center;position:relative;z-index:1;">
            <div style="font-size:2rem;margin-bottom:6px;letter-spacing:-0.02em;font-weight:800;background:linear-gradient(135deg,#6366f1,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${escHtml(app.app_name)}</div>
            <div style="color:var(--text-muted);font-size:0.75rem;letter-spacing:0.05em;">${escHtml(app.subtitle.toUpperCase())}</div>
          </div>
        </div>`;

    return `
      <a href="${escHtml(getPagePath(app))}" class="project-card" data-categories="${app.categories.join(' ')}">
        ${imageHtml}
        <div class="card-content">
          <div class="card-badges">
            ${catBadges}
          </div>
          <h3>${escHtml(app.app_name)}</h3>
          <p class="tagline">${escHtml(app.tagline)}</p>
          <div class="tech-pills">
            ${techPills}
          </div>
        </div>
        <div class="card-footer">
          <div class="card-stats">
            <span>${app.emoji} ${escHtml(app.subtitle)}</span>
          </div>
          ${arrowSvg.replace('class="', 'class="card-arrow ')}
        </div>
      </a>`;
  }).join('\n');

  // ── Assemble full page ──
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  /* === THEME OVERRIDES: full-width, no sidebar, no WP title, no white gaps === */
  .page-id-1905 .entry-title,
  .page-id-1905 .page-title,
  .page-id-1905 h1.entry-title { display: none !important; }
  .page-id-1905 #sidebar,
  .page-id-1905 .et_right_sidebar #sidebar,
  .page-id-1905 .widget-area { display: none !important; }
  .page-id-1905 #left-area,
  .page-id-1905 .et_right_sidebar #left-area,
  .page-id-1905 .et_no_sidebar #left-area { width: 100% !important; max-width: 100% !important; padding: 0 !important; float: none !important; }
  .page-id-1905 #main-content .container,
  .page-id-1905 #content-area .container,
  .page-id-1905 .entry-content .container { max-width: 100% !important; width: 100% !important; padding: 0 !important; }
  .page-id-1905 #main-content .et_pb_row { max-width: 100% !important; width: 100% !important; padding: 0 !important; }
  .page-id-1905 #main-content { padding-top: 0 !important; background: #0a0a0f !important; }
  .page-id-1905 .et_pb_section { padding: 0 !important; }
  .page-id-1905 #page-container { padding-top: 0 !important; background: #0a0a0f !important; }
  .page-id-1905 .entry-content { margin: 0 !important; padding: 0 !important; }
  .page-id-1905 #content-area { background: #0a0a0f !important; }
  .page-id-1905 .container:before,
  .page-id-1905 .container:after { display: none !important; }
  .page-id-1905 article.page { background: #0a0a0f !important; }
  .page-id-1905 #left-area article { background: #0a0a0f !important; }
  .page-id-1905 .post-content { background: #0a0a0f !important; }

  .kivi-portfolio {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-card: #16161f;
    --bg-card-hover: #1c1c28;
    --text-primary: #f0f0f5;
    --text-secondary: #9090a8;
    --text-muted: #606078;
    --border: #2a2a3a;
    --border-hover: #3a3a4f;
    --accent-gradient: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
    --cat-agents: #6366F1;
    --cat-games: #EC4899;
    --cat-business: #10B981;
    --cat-music: #F59E0B;
    --cat-hosting: #3B82F6;
    --cat-devtools: #F97316;
    --status-live: #10B981;
    --radius: 16px;
    --radius-sm: 8px;
    --radius-xs: 6px;
    background: #0a0a0f !important;
    color: #f0f0f5 !important;
    font-family: 'Outfit', sans-serif !important;
    line-height: 1.6 !important;
    position: relative !important;
    overflow: clip visible;
    margin: 0 -20px 0 -20px !important;
    padding: 0 !important;
  }
  .kivi-portfolio *, .kivi-portfolio *::before, .kivi-portfolio *::after { box-sizing: border-box !important; }
  .kivi-portfolio a { color: inherit !important; text-decoration: none !important; }
  .kivi-portfolio h1, .kivi-portfolio h2, .kivi-portfolio h3, .kivi-portfolio h4 { color: #f0f0f5 !important; padding-bottom: 0 !important; margin: 0 !important; font-family: 'Outfit', sans-serif !important; }
  .kivi-portfolio p { color: #9090a8 !important; margin: 0 !important; padding: 0 !important; }

  .kivi-portfolio .bg-glow { position: absolute !important; width: 600px !important; height: 600px !important; border-radius: 50% !important; filter: blur(150px) !important; opacity: 0.3 !important; pointer-events: none !important; z-index: 0 !important; }
  .kivi-portfolio .bg-glow-1 { top: -200px; right: -100px; background: var(--cat-agents) !important; }
  .kivi-portfolio .bg-glow-2 { bottom: -300px; left: -200px; background: var(--cat-games) !important; }
  .kivi-portfolio .kp-container { max-width: 1200px !important; margin: 0 auto !important; padding: 0 24px !important; position: relative !important; z-index: 1 !important; }

  /* HERO */
  .kivi-portfolio .kp-hero { padding: 80px 0 40px !important; text-align: center !important; }
  .kivi-portfolio .hero-badge { display: inline-flex !important; align-items: center !important; gap: 8px !important; padding: 6px 16px !important; background: rgba(99, 102, 241, 0.1) !important; border: 1px solid rgba(99, 102, 241, 0.2) !important; border-radius: 100px !important; font-size: 0.8rem !important; color: #a78bfa !important; margin-bottom: 24px !important; font-weight: 500 !important; letter-spacing: 0.02em !important; }
  .kivi-portfolio .hero-badge .dot { width: 6px !important; height: 6px !important; background: #10B981 !important; border-radius: 50% !important; animation: kp-pulse-dot 2s infinite !important; }
  @keyframes kp-pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .kivi-portfolio .kp-hero h1 { font-size: clamp(2.2rem, 5vw, 3.5rem) !important; font-weight: 800 !important; letter-spacing: -0.03em !important; line-height: 1.1 !important; margin-bottom: 20px !important; color: #f0f0f5 !important; text-align: center !important; }
  .kivi-portfolio .gradient-text { background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899) !important; -webkit-background-clip: text !important; -webkit-text-fill-color: transparent !important; background-clip: text !important; color: transparent !important; }
  .kivi-portfolio .kp-hero p { color: #9090a8 !important; font-size: 1.1rem !important; max-width: 600px !important; margin: 0 auto !important; line-height: 1.7 !important; text-align: center !important; }

  /* STATS */
  .kivi-portfolio .stats-bar { display: flex !important; justify-content: center !important; gap: 48px !important; padding: 32px 0 !important; margin-bottom: 20px !important; flex-direction: row !important; }
  .kivi-portfolio .stat { text-align: center !important; }
  .kivi-portfolio .stat-number { font-size: 1.8rem !important; font-weight: 700 !important; font-family: 'JetBrains Mono', monospace !important; background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899) !important; -webkit-background-clip: text !important; -webkit-text-fill-color: transparent !important; background-clip: text !important; color: transparent !important; }
  .kivi-portfolio .stat-label { font-size: 0.8rem !important; color: #606078 !important; text-transform: uppercase !important; letter-spacing: 0.08em !important; margin-top: 4px !important; }

  /* FILTER */
  .kivi-portfolio .filter-section { padding: 0 0 40px !important; }
  .kivi-portfolio .filter-bar { display: flex !important; justify-content: center !important; gap: 10px !important; flex-wrap: wrap !important; flex-direction: row !important; }
  .kivi-portfolio .filter-btn { padding: 8px 20px !important; border-radius: 100px !important; border: 1px solid var(--border) !important; background: transparent !important; color: #9090a8 !important; font-family: 'Outfit', sans-serif !important; font-size: 0.85rem !important; font-weight: 500 !important; cursor: pointer !important; transition: all 0.25s ease !important; }
  .kivi-portfolio .filter-btn:hover { border-color: var(--border-hover) !important; color: #f0f0f5 !important; transform: translateY(-1px); }
  .kivi-portfolio .filter-btn.active { color: #fff !important; border-color: transparent !important; }
  .kivi-portfolio .filter-btn.active[data-filter="all"] { background: var(--bg-card) !important; border-color: var(--border-hover) !important; color: #f0f0f5 !important; }
  .kivi-portfolio .filter-btn.active[data-filter="agents"] { background: #6366F1 !important; box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3) !important; }
  .kivi-portfolio .filter-btn.active[data-filter="games"] { background: #EC4899 !important; box-shadow: 0 4px 20px rgba(236, 72, 153, 0.3) !important; }
  .kivi-portfolio .filter-btn.active[data-filter="business"] { background: #10B981 !important; box-shadow: 0 4px 20px rgba(16, 185, 129, 0.3) !important; }
  .kivi-portfolio .filter-btn.active[data-filter="music"] { background: #F59E0B !important; box-shadow: 0 4px 20px rgba(245, 158, 11, 0.3) !important; }
  .kivi-portfolio .filter-btn.active[data-filter="hosting"] { background: #3B82F6 !important; box-shadow: 0 4px 20px rgba(59, 130, 246, 0.3) !important; }
  .kivi-portfolio .filter-btn.active[data-filter="devtools"] { background: #F97316 !important; box-shadow: 0 4px 20px rgba(249, 115, 22, 0.3) !important; }
  .kivi-portfolio .filter-count { display: inline-flex !important; align-items: center !important; justify-content: center !important; min-width: 20px !important; height: 20px !important; padding: 0 6px !important; border-radius: 10px !important; background: rgba(255,255,255,0.15) !important; font-size: 0.7rem !important; margin-left: 6px !important; font-family: 'JetBrains Mono', monospace !important; }

  /* FEATURED */
  .kivi-portfolio .featured-section { margin-bottom: 32px !important; }
  .kivi-portfolio .featured-label { font-size: 0.75rem !important; text-transform: uppercase !important; letter-spacing: 0.1em !important; color: #606078 !important; margin-bottom: 16px !important; display: flex !important; align-items: center !important; gap: 8px !important; }
  .kivi-portfolio .featured-label::after { content: '' !important; flex: 1 !important; height: 1px !important; background: var(--border) !important; }
  .kivi-portfolio .featured-card { display: grid !important; grid-template-columns: 1.2fr 1fr !important; gap: 0 !important; background: var(--bg-card) !important; border-radius: var(--radius) !important; border: 1px solid var(--border) !important; overflow: hidden !important; transition: all 0.35s ease; cursor: pointer !important; text-decoration: none !important; color: inherit !important; position: relative !important; }
  .kivi-portfolio .featured-card::before { content: ''; position: absolute; inset: 0; border-radius: var(--radius); background: var(--accent-gradient); opacity: 0; transition: opacity 0.35s; z-index: 0; padding: 1px; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  .kivi-portfolio .featured-card:hover::before { opacity: 1; }
  .kivi-portfolio .featured-card:hover { transform: translateY(-4px); box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
  .kivi-portfolio .featured-card:hover .featured-image img { transform: scale(1.03); }
  .kivi-portfolio .featured-image { position: relative !important; overflow: hidden !important; min-height: 280px !important; }
  .kivi-portfolio .featured-image img { width: 100% !important; height: 100% !important; object-fit: cover !important; transition: transform 0.5s ease; }
  .kivi-portfolio .featured-new-badge { position: absolute !important; top: 16px !important; left: 16px !important; padding: 4px 12px !important; background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899) !important; border-radius: 100px !important; font-size: 0.7rem !important; font-weight: 700 !important; letter-spacing: 0.06em !important; text-transform: uppercase !important; color: #fff !important; z-index: 2 !important; }
  .kivi-portfolio .featured-content { padding: 40px !important; display: flex !important; flex-direction: column !important; justify-content: center !important; position: relative !important; z-index: 1 !important; }
  .kivi-portfolio .featured-content h2 { font-size: 1.8rem !important; font-weight: 700 !important; letter-spacing: -0.02em !important; margin-bottom: 12px !important; color: #f0f0f5 !important; }
  .kivi-portfolio .featured-content .tagline { color: #9090a8 !important; font-size: 1rem !important; margin-bottom: 20px !important; line-height: 1.6 !important; }
  .kivi-portfolio .featured-meta { display: flex !important; flex-wrap: wrap !important; gap: 8px !important; margin-bottom: 24px !important; }
  .kivi-portfolio .featured-cta { display: inline-flex !important; align-items: center !important; gap: 8px !important; padding: 10px 24px !important; background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899) !important; border-radius: 100px !important; color: #fff !important; font-weight: 600 !important; font-size: 0.9rem !important; text-decoration: none !important; transition: all 0.25s; align-self: flex-start !important; }
  .kivi-portfolio .featured-cta:hover { transform: translateX(4px); box-shadow: 0 8px 30px rgba(99, 102, 241, 0.4); }

  /* GRID */
  .kivi-portfolio .grid-section { padding: 0 0 80px !important; }
  .kivi-portfolio .grid-label { font-size: 0.75rem !important; text-transform: uppercase !important; letter-spacing: 0.1em !important; color: #606078 !important; margin-bottom: 16px !important; display: flex !important; align-items: center !important; gap: 8px !important; }
  .kivi-portfolio .grid-label::after { content: '' !important; flex: 1 !important; height: 1px !important; background: var(--border) !important; }
  .kivi-portfolio .projects-grid { display: grid !important; grid-template-columns: repeat(3, 1fr) !important; gap: 20px !important; }

  /* PROJECT CARD */
  .kivi-portfolio .project-card { background: var(--bg-card) !important; border-radius: var(--radius) !important; border: 1px solid var(--border) !important; overflow: hidden !important; transition: all 0.3s ease; cursor: pointer !important; text-decoration: none !important; color: inherit !important; display: flex !important; flex-direction: column !important; position: relative !important; }
  .kivi-portfolio .project-card::before { content: ''; position: absolute; inset: 0; border-radius: var(--radius); opacity: 0; transition: opacity 0.3s; z-index: 0; padding: 1px; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  .kivi-portfolio .project-card:hover::before { opacity: 1; }
  .kivi-portfolio .project-card:hover { transform: translateY(-6px); box-shadow: 0 20px 50px rgba(0,0,0,0.3); border-color: transparent !important; }
  .kivi-portfolio .project-card:hover .card-image img { transform: scale(1.05); }
  .kivi-portfolio .project-card[data-categories*="agents"]::before { background: var(--cat-agents); }
  .kivi-portfolio .project-card[data-categories*="games"]::before { background: var(--cat-games); }
  .kivi-portfolio .project-card[data-categories*="business"]::before { background: var(--cat-business); }
  .kivi-portfolio .project-card[data-categories*="music"]::before { background: var(--cat-music); }
  .kivi-portfolio .project-card[data-categories*="hosting"]::before { background: var(--cat-hosting); }
  .kivi-portfolio .project-card[data-categories*="devtools"]::before { background: var(--cat-devtools); }

  .kivi-portfolio .card-image { position: relative !important; height: 200px !important; overflow: hidden !important; background: var(--bg-secondary) !important; }
  .kivi-portfolio .card-image img { width: 100% !important; height: 100% !important; object-fit: cover !important; transition: transform 0.4s ease; }
  .kivi-portfolio .card-content { padding: 24px !important; flex: 1 !important; display: flex !important; flex-direction: column !important; position: relative !important; z-index: 1 !important; }
  .kivi-portfolio .card-content h3 { font-size: 1.15rem !important; font-weight: 700 !important; letter-spacing: -0.01em !important; margin-bottom: 8px !important; color: #f0f0f5 !important; }
  .kivi-portfolio .card-content .tagline { color: #9090a8 !important; font-size: 0.88rem !important; margin-bottom: 16px !important; line-height: 1.5 !important; flex: 1 !important; }
  .kivi-portfolio .card-badges { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; margin-bottom: 14px !important; }
  .kivi-portfolio .cat-badge { padding: 3px 10px !important; border-radius: 100px !important; font-size: 0.7rem !important; font-weight: 500 !important; letter-spacing: 0.02em !important; }
  .kivi-portfolio .cat-agents { background: rgba(99, 102, 241, 0.15) !important; color: #a5b4fc !important; }
  .kivi-portfolio .cat-games { background: rgba(236, 72, 153, 0.15) !important; color: #f9a8d4 !important; }
  .kivi-portfolio .cat-business { background: rgba(16, 185, 129, 0.15) !important; color: #6ee7b7 !important; }
  .kivi-portfolio .cat-music { background: rgba(245, 158, 11, 0.15) !important; color: #fcd34d !important; }
  .kivi-portfolio .cat-hosting { background: rgba(59, 130, 246, 0.15) !important; color: #93c5fd !important; }
  .kivi-portfolio .cat-devtools { background: rgba(249, 115, 22, 0.15) !important; color: #fdba74 !important; }
  .kivi-portfolio .tech-pills { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; }
  .kivi-portfolio .tech-pill { padding: 3px 8px !important; border-radius: 6px !important; font-size: 0.68rem !important; font-family: 'JetBrains Mono', monospace !important; background: rgba(255,255,255,0.05) !important; color: #606078 !important; border: 1px solid rgba(255,255,255,0.06) !important; }
  .kivi-portfolio .card-footer { padding: 16px 24px !important; border-top: 1px solid var(--border) !important; display: flex !important; justify-content: space-between !important; align-items: center !important; position: relative !important; z-index: 1 !important; }
  .kivi-portfolio .card-stats { display: flex !important; gap: 16px !important; font-size: 0.75rem !important; color: #606078 !important; }
  .kivi-portfolio .card-stats span { display: flex !important; align-items: center !important; gap: 4px !important; }
  .kivi-portfolio .card-arrow { color: #606078 !important; transition: all 0.25s; }
  .kivi-portfolio .project-card:hover .card-arrow { color: #f0f0f5 !important; transform: translateX(4px); }

  .kivi-portfolio .card-image-placeholder { height: 200px !important; background: linear-gradient(135deg, #12121a, #16161f) !important; display: flex !important; align-items: center !important; justify-content: center !important; position: relative !important; overflow: hidden !important; }
  .kivi-portfolio .card-image-placeholder::before { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(255,255,255,0.02) 10px, rgba(255,255,255,0.02) 20px); }
  .kivi-portfolio .project-card.hidden { display: none !important; }
  .kivi-portfolio .featured-card.hidden { display: none !important; }
  .kivi-portfolio .featured-section.kp-hidden { display: none !important; }

  /* CTA */
  .kivi-portfolio .cta-section { padding: 60px 0 80px !important; text-align: center !important; }
  .kivi-portfolio .cta-box { background: var(--bg-card) !important; border: 1px solid var(--border) !important; border-radius: var(--radius) !important; padding: 60px 40px !important; position: relative !important; overflow: hidden !important; }
  .kivi-portfolio .cta-box::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899); }
  .kivi-portfolio .cta-box h2 { font-size: 1.6rem !important; font-weight: 700 !important; margin-bottom: 12px !important; color: #f0f0f5 !important; }
  .kivi-portfolio .cta-box p { color: #9090a8 !important; margin-bottom: 28px !important; font-size: 1rem !important; }
  .kivi-portfolio .cta-links { display: flex !important; justify-content: center !important; gap: 16px !important; flex-wrap: wrap !important; }
  .kivi-portfolio .cta-link { padding: 12px 28px !important; border-radius: 100px !important; font-weight: 600 !important; font-size: 0.9rem !important; text-decoration: none !important; transition: all 0.25s; font-family: 'Outfit', sans-serif !important; }
  .kivi-portfolio .cta-link-primary { background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899) !important; color: #fff !important; }
  .kivi-portfolio .cta-link-primary:hover { box-shadow: 0 8px 30px rgba(99, 102, 241, 0.4); transform: translateY(-2px); }
  .kivi-portfolio .cta-link-secondary { background: transparent !important; color: #9090a8 !important; border: 1px solid var(--border) !important; }
  .kivi-portfolio .cta-link-secondary:hover { border-color: var(--border-hover) !important; color: #f0f0f5 !important; transform: translateY(-2px); }

  .kivi-portfolio .kp-footer { border-top: 1px solid var(--border) !important; padding: 32px 0 !important; text-align: center !important; color: #606078 !important; font-size: 0.8rem !important; }
  .kivi-portfolio .kp-footer a { color: #9090a8 !important; text-decoration: none !important; }
  .kivi-portfolio .kp-footer a:hover { color: #f0f0f5 !important; }

  @media (max-width: 900px) {
    .kivi-portfolio .projects-grid { grid-template-columns: repeat(2, 1fr) !important; }
    .kivi-portfolio .featured-card { grid-template-columns: 1fr !important; }
    .kivi-portfolio .featured-image { min-height: 220px !important; }
    .kivi-portfolio .featured-content { padding: 28px !important; }
    .kivi-portfolio .stats-bar { gap: 32px !important; }
  }
  @media (max-width: 600px) {
    .kivi-portfolio .projects-grid { grid-template-columns: 1fr !important; }
    .kivi-portfolio .stats-bar { gap: 20px !important; }
    .kivi-portfolio .stat-number { font-size: 1.4rem !important; }
    .kivi-portfolio .kp-hero h1 { font-size: 1.8rem !important; }
    .kivi-portfolio .featured-content h2 { font-size: 1.3rem !important; }
  }

</style>

<div class="kivi-portfolio">

<div class="bg-glow bg-glow-1"></div>
<div class="bg-glow bg-glow-2"></div>

<section class="kp-hero">
  <div class="kp-container">
    <div class="hero-badge">
      <span class="dot"></span>
      ${apps.length} projects and counting
    </div>
    <h1>
      Apps &amp; Projects<br>by <span class="gradient-text">Kivi Media</span>
    </h1>
    <p>
      AI-powered apps, games, and business tools. Built with vibe coding, shipped fast, and designed to solve real problems.
    </p>
  </div>
</section>

<div class="kp-container">
  <div class="stats-bar">
    <div class="stat"><div class="stat-number">${apps.length}</div><div class="stat-label">Projects</div></div>
    <div class="stat"><div class="stat-number">${liveCount}</div><div class="stat-label">Live</div></div>
    <div class="stat"><div class="stat-number">${activeCats.length}</div><div class="stat-label">Categories</div></div>
    <div class="stat"><div class="stat-number">20+</div><div class="stat-label">Technologies</div></div>
  </div>
</div>

<section class="filter-section">
  <div class="kp-container">
    <div class="filter-bar">
      ${filterButtons}
    </div>
  </div>
</section>

${featuredHtml}

<section class="grid-section">
  <div class="kp-container">
    <div class="grid-label">All Projects</div>
    <div class="projects-grid">
      ${projectCards}
    </div>
  </div>
</section>

<section class="cta-section">
  <div class="kp-container">
    <div class="cta-box">
      <h2>Want something built?</h2>
      <p>From AI agents to full-stack apps, Kivi Media ships fast with vibe coding.</p>
      <div class="cta-links">
        <a href="https://zivraviv.com/contact" class="cta-link cta-link-primary">Talk to Ziv</a>
        <a href="https://github.com/kivimedia" class="cta-link cta-link-secondary" target="_blank" rel="noopener">View GitHub</a>
      </div>
    </div>
  </div>
</section>

<div class="kp-footer">
  <div class="kp-container">
    <p>Built by <a href="https://zivraviv.com">Kivi Media</a> &middot; Designed by AI agents &middot; Powered by vibe coding</p>
  </div>
</div>

</div>

<script>
(function() {
  var filterBtns = document.querySelectorAll('.kivi-portfolio .filter-btn');
  var cards = document.querySelectorAll('.kivi-portfolio .project-card');
  var featuredCard = document.querySelector('.kivi-portfolio .featured-card');
  var featuredSection = document.getElementById('kp-featured-section');

  filterBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      filterBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var filter = btn.dataset.filter;
      cards.forEach(function(card) {
        var cats = card.dataset.categories || '';
        if (filter === 'all' || cats.indexOf(filter) !== -1) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });
      if (featuredCard && featuredSection) {
        var featCats = featuredCard.dataset.categories || '';
        if (filter === 'all' || featCats.indexOf(filter) !== -1) {
          featuredSection.classList.remove('kp-hidden');
        } else {
          featuredSection.classList.add('kp-hidden');
        }
      }
    });
  });
})();
</script>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  log.info('═══ Portfolio Page Update ═══');

  log.info('Fetching published apps from pipeline database...');
  const rawApps = await getPublishedApps();
  log.info(`Found ${rawApps.length} published apps`);

  if (rawApps.length === 0) {
    log.warn('No published apps found — skipping portfolio update');
    return;
  }

  // Enrich with category metadata
  const apps: AppCard[] = rawApps.map(app => {
    const shortName = getRepoShortName(app.repo_name);
    const meta = REPO_CATEGORIES[shortName] ?? { categories: ['business'] as Category[], emoji: '📁', subtitle: 'Project' };
    return {
      ...app,
      app_name: app.app_name.replace(/\[REVIEW NEEDED\]\s*/g, ''),
      categories: meta.categories,
      emoji: meta.emoji,
      subtitle: meta.subtitle,
    };
  });

  for (const app of apps) {
    log.info(`  ${app.app_name} [${app.categories.join(', ')}] → ${app.wp_page_url} (confidence: ${app.confidence_score})`);
  }

  if (dryRun) {
    log.info('DRY RUN — no changes made');
    return;
  }

  const content = generatePortfolioContent(apps);

  const portfolioPage = await findPageBySlug('apps');
  if (!portfolioPage) {
    log.error('Portfolio page (slug: "apps") not found in WordPress!');
    process.exit(1);
  }

  log.info(`Updating portfolio page (ID: ${portfolioPage.id})...`);
  const result = await updatePage(portfolioPage.id, 'Apps & Projects', content, 'publish');
  log.info(`✓ Portfolio updated: ${result.pageUrl}`);
}

main().catch(err => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
