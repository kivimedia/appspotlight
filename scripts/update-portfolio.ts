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
    <a href="${escHtml(getPagePath(featured))}" class="featured-card animate-in delay-5" data-categories="${featured.categories.join(' ')}">
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
    const delay = `delay-${Math.min(i + 1, 6)}`;
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
      <a href="${escHtml(getPagePath(app))}" class="project-card animate-in ${delay}" data-categories="${app.categories.join(' ')}">
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
  return `<style>
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
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: 'Outfit', sans-serif;
    line-height: 1.6;
    position: relative;
    overflow: clip visible;
    margin: 0 -20px 0 -20px;
    padding: 0;
  }
  .kivi-portfolio *, .kivi-portfolio *::before, .kivi-portfolio *::after { box-sizing: border-box; }
  .kivi-portfolio a { color: inherit; }
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  .kivi-portfolio .bg-glow { position: absolute; width: 600px; height: 600px; border-radius: 50%; filter: blur(150px); opacity: 0.3; pointer-events: none; z-index: 0; }
  .kivi-portfolio .bg-glow-1 { top: -200px; right: -100px; background: var(--cat-agents); }
  .kivi-portfolio .bg-glow-2 { bottom: -300px; left: -200px; background: var(--cat-games); }
  .kivi-portfolio .kp-container { max-width: 1200px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }

  /* HERO */
  .kivi-portfolio .kp-hero { padding: 80px 0 40px; text-align: center; }
  .kivi-portfolio .hero-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.2); border-radius: 100px; font-size: 0.8rem; color: #a78bfa; margin-bottom: 24px; font-weight: 500; letter-spacing: 0.02em; }
  .kivi-portfolio .hero-badge .dot { width: 6px; height: 6px; background: #10B981; border-radius: 50%; animation: kp-pulse-dot 2s infinite; }
  @keyframes kp-pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .kivi-portfolio .kp-hero h1 { font-size: clamp(2.2rem, 5vw, 3.5rem); font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; margin-bottom: 20px; color: var(--text-primary); }
  .kivi-portfolio .gradient-text { background: var(--accent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .kivi-portfolio .kp-hero p { color: var(--text-secondary); font-size: 1.1rem; max-width: 600px; margin: 0 auto; line-height: 1.7; }

  /* STATS */
  .kivi-portfolio .stats-bar { display: flex; justify-content: center; gap: 48px; padding: 32px 0; margin-bottom: 20px; }
  .kivi-portfolio .stat { text-align: center; }
  .kivi-portfolio .stat-number { font-size: 1.8rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; background: var(--accent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .kivi-portfolio .stat-label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }

  /* FILTER */
  .kivi-portfolio .filter-section { padding: 0 0 40px; }
  .kivi-portfolio .filter-bar { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
  .kivi-portfolio .filter-btn { padding: 8px 20px; border-radius: 100px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); font-family: 'Outfit', sans-serif; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: all 0.25s ease; }
  .kivi-portfolio .filter-btn:hover { border-color: var(--border-hover); color: var(--text-primary); transform: translateY(-1px); }
  .kivi-portfolio .filter-btn.active { color: #fff; border-color: transparent; }
  .kivi-portfolio .filter-btn.active[data-filter="all"] { background: var(--bg-card); border-color: var(--border-hover); color: var(--text-primary); }
  .kivi-portfolio .filter-btn.active[data-filter="agents"] { background: var(--cat-agents); box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3); }
  .kivi-portfolio .filter-btn.active[data-filter="games"] { background: var(--cat-games); box-shadow: 0 4px 20px rgba(236, 72, 153, 0.3); }
  .kivi-portfolio .filter-btn.active[data-filter="business"] { background: var(--cat-business); box-shadow: 0 4px 20px rgba(16, 185, 129, 0.3); }
  .kivi-portfolio .filter-btn.active[data-filter="music"] { background: var(--cat-music); box-shadow: 0 4px 20px rgba(245, 158, 11, 0.3); }
  .kivi-portfolio .filter-btn.active[data-filter="hosting"] { background: var(--cat-hosting); box-shadow: 0 4px 20px rgba(59, 130, 246, 0.3); }
  .kivi-portfolio .filter-btn.active[data-filter="devtools"] { background: var(--cat-devtools); box-shadow: 0 4px 20px rgba(249, 115, 22, 0.3); }
  .kivi-portfolio .filter-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: rgba(255,255,255,0.15); font-size: 0.7rem; margin-left: 6px; font-family: 'JetBrains Mono', monospace; }

  /* FEATURED */
  .kivi-portfolio .featured-section { margin-bottom: 32px; }
  .kivi-portfolio .featured-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .kivi-portfolio .featured-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .kivi-portfolio .featured-card { display: grid; grid-template-columns: 1.2fr 1fr; gap: 0; background: var(--bg-card); border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; transition: all 0.35s ease; cursor: pointer; text-decoration: none; color: inherit; position: relative; }
  .kivi-portfolio .featured-card::before { content: ''; position: absolute; inset: 0; border-radius: var(--radius); background: var(--accent-gradient); opacity: 0; transition: opacity 0.35s; z-index: 0; padding: 1px; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  .kivi-portfolio .featured-card:hover::before { opacity: 1; }
  .kivi-portfolio .featured-card:hover { transform: translateY(-4px); box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
  .kivi-portfolio .featured-card:hover .featured-image img { transform: scale(1.03); }
  .kivi-portfolio .featured-image { position: relative; overflow: hidden; min-height: 280px; }
  .kivi-portfolio .featured-image img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.5s ease; }
  .kivi-portfolio .featured-new-badge { position: absolute; top: 16px; left: 16px; padding: 4px 12px; background: var(--accent-gradient); border-radius: 100px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #fff; z-index: 2; }
  .kivi-portfolio .featured-content { padding: 40px; display: flex; flex-direction: column; justify-content: center; position: relative; z-index: 1; }
  .kivi-portfolio .featured-content h2 { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 12px; color: var(--text-primary); }
  .kivi-portfolio .featured-content .tagline { color: var(--text-secondary); font-size: 1rem; margin-bottom: 20px; line-height: 1.6; }
  .kivi-portfolio .featured-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
  .kivi-portfolio .featured-cta { display: inline-flex; align-items: center; gap: 8px; padding: 10px 24px; background: var(--accent-gradient); border-radius: 100px; color: #fff; font-weight: 600; font-size: 0.9rem; text-decoration: none; transition: all 0.25s; align-self: flex-start; }
  .kivi-portfolio .featured-cta:hover { transform: translateX(4px); box-shadow: 0 8px 30px rgba(99, 102, 241, 0.4); }

  /* GRID */
  .kivi-portfolio .grid-section { padding: 0 0 80px; }
  .kivi-portfolio .grid-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .kivi-portfolio .grid-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .kivi-portfolio .projects-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }

  /* PROJECT CARD */
  .kivi-portfolio .project-card { background: var(--bg-card); border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; transition: all 0.3s ease; cursor: pointer; text-decoration: none; color: inherit; display: flex; flex-direction: column; position: relative; }
  .kivi-portfolio .project-card::before { content: ''; position: absolute; inset: 0; border-radius: var(--radius); opacity: 0; transition: opacity 0.3s; z-index: 0; padding: 1px; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  .kivi-portfolio .project-card:hover::before { opacity: 1; }
  .kivi-portfolio .project-card:hover { transform: translateY(-6px); box-shadow: 0 20px 50px rgba(0,0,0,0.3); border-color: transparent; }
  .kivi-portfolio .project-card:hover .card-image img { transform: scale(1.05); }
  .kivi-portfolio .project-card[data-categories*="agents"]::before { background: var(--cat-agents); }
  .kivi-portfolio .project-card[data-categories*="games"]::before { background: var(--cat-games); }
  .kivi-portfolio .project-card[data-categories*="business"]::before { background: var(--cat-business); }
  .kivi-portfolio .project-card[data-categories*="music"]::before { background: var(--cat-music); }
  .kivi-portfolio .project-card[data-categories*="hosting"]::before { background: var(--cat-hosting); }
  .kivi-portfolio .project-card[data-categories*="devtools"]::before { background: var(--cat-devtools); }

  .kivi-portfolio .card-image { position: relative; height: 200px; overflow: hidden; background: var(--bg-secondary); }
  .kivi-portfolio .card-image img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.4s ease; }
  .kivi-portfolio .card-content { padding: 24px; flex: 1; display: flex; flex-direction: column; position: relative; z-index: 1; }
  .kivi-portfolio .card-content h3 { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 8px; color: var(--text-primary); }
  .kivi-portfolio .card-content .tagline { color: var(--text-secondary); font-size: 0.88rem; margin-bottom: 16px; line-height: 1.5; flex: 1; }
  .kivi-portfolio .card-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .kivi-portfolio .cat-badge { padding: 3px 10px; border-radius: 100px; font-size: 0.7rem; font-weight: 500; letter-spacing: 0.02em; }
  .kivi-portfolio .cat-agents { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; }
  .kivi-portfolio .cat-games { background: rgba(236, 72, 153, 0.15); color: #f9a8d4; }
  .kivi-portfolio .cat-business { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; }
  .kivi-portfolio .cat-music { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }
  .kivi-portfolio .cat-hosting { background: rgba(59, 130, 246, 0.15); color: #93c5fd; }
  .kivi-portfolio .cat-devtools { background: rgba(249, 115, 22, 0.15); color: #fdba74; }
  .kivi-portfolio .tech-pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .kivi-portfolio .tech-pill { padding: 3px 8px; border-radius: var(--radius-xs); font-size: 0.68rem; font-family: 'JetBrains Mono', monospace; background: rgba(255,255,255,0.05); color: var(--text-muted); border: 1px solid rgba(255,255,255,0.06); }
  .kivi-portfolio .card-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 1; }
  .kivi-portfolio .card-stats { display: flex; gap: 16px; font-size: 0.75rem; color: var(--text-muted); }
  .kivi-portfolio .card-stats span { display: flex; align-items: center; gap: 4px; }
  .kivi-portfolio .card-arrow { color: var(--text-muted); transition: all 0.25s; }
  .kivi-portfolio .project-card:hover .card-arrow { color: var(--text-primary); transform: translateX(4px); }

  .kivi-portfolio .card-image-placeholder { height: 200px; background: linear-gradient(135deg, var(--bg-secondary), var(--bg-card)); display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
  .kivi-portfolio .card-image-placeholder::before { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(255,255,255,0.02) 10px, rgba(255,255,255,0.02) 20px); }
  .kivi-portfolio .project-card.hidden { display: none; }
  .kivi-portfolio .featured-card.hidden { display: none; }
  .kivi-portfolio .featured-section.kp-hidden { display: none; }

  /* CTA */
  .kivi-portfolio .cta-section { padding: 60px 0 80px; text-align: center; }
  .kivi-portfolio .cta-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 60px 40px; position: relative; overflow: hidden; }
  .kivi-portfolio .cta-box::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--accent-gradient); }
  .kivi-portfolio .cta-box h2 { font-size: 1.6rem; font-weight: 700; margin-bottom: 12px; color: var(--text-primary); }
  .kivi-portfolio .cta-box p { color: var(--text-secondary); margin-bottom: 28px; font-size: 1rem; }
  .kivi-portfolio .cta-links { display: flex; justify-content: center; gap: 16px; flex-wrap: wrap; }
  .kivi-portfolio .cta-link { padding: 12px 28px; border-radius: 100px; font-weight: 600; font-size: 0.9rem; text-decoration: none; transition: all 0.25s; font-family: 'Outfit', sans-serif; }
  .kivi-portfolio .cta-link-primary { background: var(--accent-gradient); color: #fff; }
  .kivi-portfolio .cta-link-primary:hover { box-shadow: 0 8px 30px rgba(99, 102, 241, 0.4); transform: translateY(-2px); }
  .kivi-portfolio .cta-link-secondary { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
  .kivi-portfolio .cta-link-secondary:hover { border-color: var(--border-hover); color: var(--text-primary); transform: translateY(-2px); }

  .kivi-portfolio .kp-footer { border-top: 1px solid var(--border); padding: 32px 0; text-align: center; color: var(--text-muted); font-size: 0.8rem; }
  .kivi-portfolio .kp-footer a { color: var(--text-secondary); text-decoration: none; }
  .kivi-portfolio .kp-footer a:hover { color: var(--text-primary); }

  @media (max-width: 900px) {
    .kivi-portfolio .projects-grid { grid-template-columns: repeat(2, 1fr); }
    .kivi-portfolio .featured-card { grid-template-columns: 1fr; }
    .kivi-portfolio .featured-image { min-height: 220px; }
    .kivi-portfolio .featured-content { padding: 28px; }
    .kivi-portfolio .stats-bar { gap: 32px; }
  }
  @media (max-width: 600px) {
    .kivi-portfolio .projects-grid { grid-template-columns: 1fr; }
    .kivi-portfolio .stats-bar { gap: 20px; }
    .kivi-portfolio .stat-number { font-size: 1.4rem; }
    .kivi-portfolio .kp-hero h1 { font-size: 1.8rem; }
    .kivi-portfolio .featured-content h2 { font-size: 1.3rem; }
  }

  @keyframes kp-fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  .kivi-portfolio .animate-in { animation: kp-fadeUp 0.5s ease forwards; opacity: 0; }
  .kivi-portfolio .delay-1 { animation-delay: 0.1s; }
  .kivi-portfolio .delay-2 { animation-delay: 0.2s; }
  .kivi-portfolio .delay-3 { animation-delay: 0.3s; }
  .kivi-portfolio .delay-4 { animation-delay: 0.4s; }
  .kivi-portfolio .delay-5 { animation-delay: 0.5s; }
  .kivi-portfolio .delay-6 { animation-delay: 0.6s; }
</style>

<div class="kivi-portfolio">

<div class="bg-glow bg-glow-1"></div>
<div class="bg-glow bg-glow-2"></div>

<section class="kp-hero">
  <div class="kp-container">
    <div class="hero-badge animate-in">
      <span class="dot"></span>
      ${apps.length} projects and counting
    </div>
    <h1 class="animate-in delay-1">
      Apps &amp; Projects<br>by <span class="gradient-text">Kivi Media</span>
    </h1>
    <p class="animate-in delay-2">
      AI-powered apps, games, and business tools. Built with vibe coding, shipped fast, and designed to solve real problems.
    </p>
  </div>
</section>

<div class="kp-container">
  <div class="stats-bar animate-in delay-3">
    <div class="stat"><div class="stat-number">${apps.length}</div><div class="stat-label">Projects</div></div>
    <div class="stat"><div class="stat-number">${liveCount}</div><div class="stat-label">Live</div></div>
    <div class="stat"><div class="stat-number">${activeCats.length}</div><div class="stat-label">Categories</div></div>
    <div class="stat"><div class="stat-number">20+</div><div class="stat-label">Technologies</div></div>
  </div>
</div>

<section class="filter-section">
  <div class="kp-container">
    <div class="filter-bar animate-in delay-4">
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
