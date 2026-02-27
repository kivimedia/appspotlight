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

  // For apps without page screenshots, try the media library
  const apps: AppPageInfo[] = [];
  for (const row of result.rows) {
    let screenshot_url = screenshotMap.get(row.wp_page_id ?? 0) ?? null;
    if (!screenshot_url) {
      const shortName = row.repo_name.replace(/^kivimedia\//, '');
      screenshot_url = await findMediaScreenshot(shortName);
      if (screenshot_url) {
        log.info(`  Found media library screenshot for ${shortName}: ${screenshot_url.substring(0, 80)}`);
      }
    }
    apps.push({ ...row, screenshot_url });
  }
  return apps;
}

// ─── WP Screenshot Extraction ───────────────────────────────────────────────

function extractFirstImage(html: string): string | null {
  // Match first <img> src that looks like a screenshot (WP media or external URL with image extension)
  const imgMatch = html.match(/<img[^>]+src="([^"]+\.(webp|png|jpg|jpeg)[^"]*)"/i);
  return imgMatch?.[1] ?? null;
}

async function fetchScreenshotsFromWP(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const config = getConfig();
  const auth = Buffer.from(`${config.wordpress.username}:${config.wordpress.appPassword}`).toString('base64');

  try {
    // 1. Fetch all child pages of /apps/ — they return rendered content
    const childPages = await fetchChildPages('apps');
    for (const page of childPages) {
      const img = extractFirstImage(page.content);
      if (img) map.set(page.id, img);
    }

    // 2. Also fetch top-level app pages (older apps not under /apps/)
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

/** Search WP media library for a screenshot matching the repo name */
async function findMediaScreenshot(repoName: string): Promise<string | null> {
  const config = getConfig();
  const auth = Buffer.from(`${config.wordpress.username}:${config.wordpress.appPassword}`).toString('base64');
  const searchTerm = repoName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  try {
    const resp = await fetch(
      `${config.wordpress.baseUrl}/wp-json/wp/v2/media?search=${searchTerm}&per_page=5&_fields=id,source_url,mime_type&mime_type=image`,
      { headers: { 'Authorization': `Basic ${auth}` } },
    );
    if (!resp.ok) return null;
    const media = await resp.json() as Array<{ id: number; source_url: string; mime_type: string }>;
    // Prefer desktop screenshots, then any image
    const desktop = media.find(m => m.source_url.includes('desktop'));
    return (desktop ?? media[0])?.source_url ?? null;
  } catch {
    return null;
  }
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

  // ── Shared inline style fragments ──
  const S = {
    reset: 'box-sizing:border-box;margin:0;padding:0;',
    font: "font-family:'Outfit',sans-serif;",
    mono: "font-family:'JetBrains Mono',monospace;",
    container: 'max-width:1200px;margin:0 auto;padding:0 24px;position:relative;z-index:1;',
    badge: 'padding:3px 10px;border-radius:100px;font-size:0.7rem;font-weight:500;display:inline-block;',
    pill: "padding:3px 8px;border-radius:6px;font-size:0.68rem;font-family:'JetBrains Mono',monospace;background:rgba(255,255,255,0.05);color:#606078;border:1px solid rgba(255,255,255,0.06);display:inline-block;",
  };

  // ── Build filter buttons with inline onclick (WP strips <script> tags) ──
  const btnBase = `${S.font}padding:8px 20px;border-radius:100px;border:1px solid #2a2a3a;background:transparent;color:#9090a8;font-size:0.85rem;font-weight:500;cursor:pointer;`;
  const btnActiveAll = `background:#16161f;border-color:#3a3a4f;color:#f0f0f5;`;
  // Filter function: resets all button styles, sets clicked one active, hides/shows cards
  const filterFn = `(function(b){var r=document.getElementById('kp-root');if(!r)return;var f=b.dataset.filter;var bg={all:'background:#16161f;border-color:#3a3a4f;color:#f0f0f5',agents:'background:#6366F1;color:#fff;border-color:transparent',games:'background:#EC4899;color:#fff;border-color:transparent',business:'background:#10B981;color:#fff;border-color:transparent',music:'background:#F59E0B;color:#fff;border-color:transparent',hosting:'background:#3B82F6;color:#fff;border-color:transparent',devtools:'background:#F97316;color:#fff;border-color:transparent'};document.getElementById('kp-filter-bar').querySelectorAll('button').forEach(function(x){x.style.background='transparent';x.style.borderColor='#2a2a3a';x.style.color='#9090a8'});var s=bg[f];if(s){s.split(';').forEach(function(p){var kv=p.split(':');if(kv.length===2)b.style[kv[0].trim().replace(/-([a-z])/g,function(m,c){return c.toUpperCase()})]=kv[1].trim()})}r.querySelectorAll('.project-card').forEach(function(c){var d=c.dataset.categories||'';c.style.display=(f==='all'||d.indexOf(f)!==-1)?'flex':'none'});var fs=document.getElementById('kp-featured-section');if(fs){var fc=fs.querySelector('[data-categories]');var fd=fc?fc.dataset.categories||'':'';fs.style.display=(f==='all'||fd.indexOf(f)!==-1)?'block':'none'}})(this)`;
  const countStyle = `display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:rgba(255,255,255,0.15);font-size:0.7rem;margin-left:6px;${S.mono}`;
  const filterButtons = [
    `<button data-filter="all" onclick="${filterFn}" style="${btnBase}${btnActiveAll}">All<span style="${countStyle}">${apps.length}</span></button>`,
    ...activeCats.map(([cat, count]) => {
      const meta = CATEGORY_META[cat as Category];
      return `<button data-filter="${cat}" onclick="${filterFn}" style="${btnBase}">${meta.emoji} ${meta.label}<span style="${countStyle}">${count}</span></button>`;
    }),
  ].join('\n      ');

  // ── Category badge colors ──
  const catBadgeStyle: Record<string, string> = {
    agents:   'background:rgba(99,102,241,0.15);color:#a5b4fc;',
    games:    'background:rgba(236,72,153,0.15);color:#f9a8d4;',
    business: 'background:rgba(16,185,129,0.15);color:#6ee7b7;',
    music:    'background:rgba(245,158,11,0.15);color:#fcd34d;',
    hosting:  'background:rgba(59,130,246,0.15);color:#93c5fd;',
    devtools: 'background:rgba(249,115,22,0.15);color:#fdba74;',
  };
  const catFilterBg: Record<string, string> = {
    all:      'background:#16161f;border-color:#3a3a4f;color:#f0f0f5;',
    agents:   'background:#6366F1;color:#fff;border-color:transparent;',
    games:    'background:#EC4899;color:#fff;border-color:transparent;',
    business: 'background:#10B981;color:#fff;border-color:transparent;',
    music:    'background:#F59E0B;color:#fff;border-color:transparent;',
    hosting:  'background:#3B82F6;color:#fff;border-color:transparent;',
    devtools: 'background:#F97316;color:#fff;border-color:transparent;',
  };

  // ── Build featured card ──
  const featuredHtml = featured ? (() => {
    const featCatBadges = featured.categories.map(c =>
      `<span style="${S.badge}${catBadgeStyle[c]}">${CATEGORY_META[c].label}</span>`
    ).join(' ');
    const featTechPills = featured.tech_stack.slice(0, 5).map(t =>
      `<span style="${S.pill}">${escHtml(t)}</span>`
    ).join(' ');
    const featImg = featured.screenshot_url
      ? `<img decoding="async" src="${escHtml(featured.screenshot_url)}" alt="${escHtml(featured.app_name)}" loading="eager" fetchpriority="high" width="600" height="400" style="width:100%;height:100%;object-fit:cover;display:block;">`
      : `<div style="height:100%;min-height:280px;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);display:flex;align-items:center;justify-content:center;"><div style="text-align:center;"><div style="font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,#6366f1,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${escHtml(featured.app_name)}</div></div></div>`;
    return `<div id="kp-featured-section" data-categories="${featured.categories.join(' ')}" style="${S.reset}margin-bottom:32px;"><div style="${S.container}"><div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#606078;margin-bottom:16px;">Featured Project</div><div class="featured-card" data-categories="${featured.categories.join(' ')}" onclick="window.location.href='${escHtml(getPagePath(featured))}'" style="display:grid;grid-template-columns:var(--kp-feat-cols,1.2fr 1fr);gap:0;background:#16161f;border-radius:16px;border:1px solid #2a2a3a;overflow:hidden;cursor:pointer;text-decoration:none;color:#f0f0f5;position:relative;"><div style="position:relative;overflow:hidden;min-height:var(--kp-feat-min-h,280px);"><span style="position:absolute;top:16px;left:16px;padding:4px 12px;background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);border-radius:100px;font-size:0.7rem;font-weight:700;text-transform:uppercase;color:#fff;z-index:2;">&#x2B50; Featured</span>${featImg}</div><div style="padding:var(--kp-feat-pad,40px);display:flex;flex-direction:column;justify-content:center;position:relative;z-index:1;"><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">${featCatBadges}</div><h2 style="color:#f0f0f5;${S.font}font-size:1.8rem;font-weight:700;margin:0 0 12px 0;padding:0;">${escHtml(featured.app_name)}</h2><div style="color:#9090a8;font-size:1rem;margin:0 0 20px 0;padding:0;line-height:1.6;">${escHtml(featured.tagline)}</div><div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;">${featTechPills}</div><span style="display:inline-flex;align-items:center;gap:8px;padding:10px 24px;background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);border-radius:100px;color:#fff;font-weight:600;font-size:0.9rem;text-decoration:none;align-self:flex-start;">View Project ${arrowSvg}</span></div></div></div></div>`;
  })() : '';

  // ── Build project cards ──
  const projectCards = gridApps.map(app => {
    const catBadges = app.categories.map(c =>
      `<span style="${S.badge}${catBadgeStyle[c]}">${CATEGORY_META[c].label}</span>`
    ).join(' ');
    const techPills = app.tech_stack.slice(0, 4).map(t =>
      `<span style="${S.pill}">${escHtml(t)}</span>`
    ).join(' ');
    const hasScreenshot = app.screenshot_url && !app.screenshot_url.includes('branded-card');
    const imageHtml = hasScreenshot
      ? `<div style="position:relative;height:200px;overflow:hidden;background:#12121a;"><img decoding="async" src="${escHtml(app.screenshot_url!)}" alt="${escHtml(app.app_name)}" loading="lazy" width="400" height="200" style="width:100%;height:100%;object-fit:cover;display:block;"></div>`
      : `<div style="height:200px;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;">
          <div style="text-align:center;position:relative;z-index:1;">
            <div style="font-size:2rem;margin-bottom:6px;letter-spacing:-0.02em;font-weight:800;background:linear-gradient(135deg,#6366f1,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${escHtml(app.app_name)}</div>
            <div style="color:#606078;font-size:0.75rem;letter-spacing:0.05em;">${escHtml(app.subtitle.toUpperCase())}</div>
          </div>
        </div>`;

    return `<div class="project-card" data-categories="${app.categories.join(' ')}" onclick="window.location.href='${escHtml(getPagePath(app))}'" style="background:#16161f;border-radius:16px;border:1px solid #2a2a3a;overflow:hidden;cursor:pointer;text-decoration:none;color:#f0f0f5;display:flex;flex-direction:column;position:relative;transition:transform 0.3s ease,box-shadow 0.3s ease;">${imageHtml}<div style="padding:24px;flex:1;display:flex;flex-direction:column;position:relative;z-index:1;"><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">${catBadges}</div><h3 style="color:#f0f0f5;${S.font}font-size:1.15rem;font-weight:700;margin:0 0 8px 0;padding:0;">${escHtml(app.app_name)}</h3><div style="color:#9090a8;font-size:0.88rem;margin:0 0 16px 0;padding:0;line-height:1.5;flex:1;">${escHtml(app.tagline)}</div><div style="display:flex;flex-wrap:wrap;gap:6px;">${techPills}</div></div><div style="padding:16px 24px;border-top:1px solid #2a2a3a;display:flex;flex-direction:row;justify-content:space-between;align-items:center;position:relative;z-index:1;"><div style="display:flex;flex-direction:row;gap:16px;font-size:0.75rem;color:#606078;"><span style="display:flex;align-items:center;gap:4px;">${app.emoji} ${escHtml(app.subtitle)}</span></div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#606078" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div></div>`;
  }).join('');

  // ── Active filter button styles (for JS onclick) ──
  const filterBgJson = JSON.stringify(catFilterBg).replace(/"/g, "'");

  // ── Minimal CSS: ONLY for hover, media queries, hide/show (can't be inline) ──
  // ALL structural/visual styles are INLINE to defeat Divi.
  // NO <p> tags anywhere — wpautop inserts <p> around inline elements.
  // NO newlines between block elements — wpautop turns those into <p> too.
  const css = `<style>.page-id-1905 .entry-title,.page-id-1905 .page-title,.page-id-1905 h1.entry-title{display:none!important}.page-id-1905 #sidebar,.page-id-1905 .widget-area{display:none!important}.page-id-1905 #left-area,.page-id-1905 .et_right_sidebar #left-area,.page-id-1905 .et_no_sidebar #left-area{width:100%!important;max-width:100%!important;padding:0!important;float:none!important}.page-id-1905 #main-content,.page-id-1905 #page-container,.page-id-1905 #content-area,.page-id-1905 article.page,.page-id-1905 .entry-content{background:#0a0a0f!important;padding:0!important;margin:0!important}.page-id-1905 #main-content .container{max-width:100%!important;width:100%!important;padding:0!important}.page-id-1905 .et_pb_section{padding:0!important}.page-id-1905 #main-content .et_pb_row{max-width:100%!important;width:100%!important;padding:0!important}#kp-root .project-card:hover{transform:translateY(-6px)!important;box-shadow:0 20px 50px rgba(0,0,0,0.3)!important}@keyframes kp-pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}#kp-root{--kp-grid-cols:repeat(3,1fr);--kp-grid-gap:20px;--kp-feat-cols:1.2fr 1fr;--kp-stat-gap:48px;--kp-stat-dir:row;--kp-hero-pad:80px 0 40px;--kp-cta-pad:60px 40px;--kp-cta-outer:60px 0 80px;--kp-feat-pad:40px;--kp-feat-min-h:280px}@media(max-width:900px){#kp-root{--kp-grid-cols:repeat(2,1fr);--kp-feat-cols:1fr;--kp-stat-gap:32px;--kp-hero-pad:60px 0 32px;--kp-feat-pad:28px;--kp-feat-min-h:220px;--kp-cta-pad:40px 28px;--kp-cta-outer:40px 0 60px}}@media(max-width:600px){#kp-root{--kp-grid-cols:1fr;--kp-grid-gap:16px;--kp-stat-gap:16px;--kp-hero-pad:48px 0 24px;--kp-feat-pad:20px;--kp-feat-min-h:200px;--kp-cta-pad:32px 20px;--kp-cta-outer:32px 0 48px}}</style>`;

  const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">`;

  // Build as one continuous string with NO newlines between block elements
  const parts: string[] = [];
  parts.push(fonts);
  parts.push(css);
  parts.push(`<div id="kp-root" style="background:#0a0a0f;color:#f0f0f5;${S.font}line-height:1.6;position:relative;overflow:hidden;margin:0;padding:0;">`);

  // HERO
  parts.push(`<div style="padding:var(--kp-hero-pad,80px 0 40px);text-align:center;"><div style="${S.container}"><div style="display:inline-flex;align-items:center;gap:8px;padding:6px 16px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);border-radius:100px;font-size:0.8rem;color:#a78bfa;margin-bottom:24px;font-weight:500;"><span style="width:6px;height:6px;background:#10B981;border-radius:50%;display:inline-block;animation:kp-pulse-dot 2s infinite;"></span> ${apps.length} projects and counting</div><h1 style="color:#f0f0f5;${S.font}font-size:clamp(2.2rem,5vw,3.5rem);font-weight:800;letter-spacing:-0.03em;line-height:1.1;margin:0 0 20px 0;padding:0;text-align:center;">Apps &amp; Projects<br>by <span style="background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">Kivi Media</span></h1><div style="color:#9090a8;font-size:1.1rem;max-width:600px;margin:0 auto;line-height:1.7;padding:0;text-align:center;">AI-powered apps, games, and business tools. Built with vibe coding, shipped fast, and designed to solve real problems.</div></div></div>`);

  // STATS
  const statStyle = `${S.mono}font-size:1.8rem;font-weight:700;background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;`;
  const statLabel = `font-size:0.8rem;color:#606078;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px;`;
  parts.push(`<div style="${S.container}"><div style="display:flex;flex-direction:var(--kp-stat-dir,row);justify-content:center;gap:var(--kp-stat-gap,48px);padding:32px 0;margin-bottom:20px;flex-wrap:wrap;"><div style="text-align:center;"><div style="${statStyle}">${apps.length}</div><div style="${statLabel}">Projects</div></div><div style="text-align:center;"><div style="${statStyle}">${liveCount}</div><div style="${statLabel}">Live</div></div><div style="text-align:center;"><div style="${statStyle}">${activeCats.length}</div><div style="${statLabel}">Categories</div></div><div style="text-align:center;"><div style="${statStyle}">20+</div><div style="${statLabel}">Technologies</div></div></div></div>`);

  // FILTER
  parts.push(`<div style="padding:0 0 40px;"><div style="${S.container}"><div id="kp-filter-bar" style="display:flex;flex-direction:row;justify-content:center;gap:10px;flex-wrap:wrap;">${filterButtons}</div></div></div>`);

  // FEATURED
  if (featuredHtml) parts.push(featuredHtml);

  // PROJECTS GRID
  parts.push(`<div style="padding:0 0 80px;"><div style="${S.container}"><div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#606078;margin-bottom:16px;">All Projects</div><div id="kp-grid" style="display:grid;grid-template-columns:var(--kp-grid-cols,repeat(3,1fr));gap:var(--kp-grid-gap,20px);width:100%;">${projectCards}</div></div></div>`);

  // CTA
  parts.push(`<div style="padding:var(--kp-cta-outer,60px 0 80px);text-align:center;"><div style="${S.container}"><div style="background:#16161f;border:1px solid #2a2a3a;border-radius:16px;padding:var(--kp-cta-pad,60px 40px);position:relative;overflow:hidden;border-top:2px solid;border-image:linear-gradient(135deg,#6366f1,#a855f7,#ec4899) 1;"><h2 style="color:#f0f0f5;${S.font}font-size:1.6rem;font-weight:700;margin:0 0 12px 0;padding:0;">Want something built?</h2><div style="color:#9090a8;margin:0 0 28px 0;padding:0;font-size:1rem;">From AI agents to full-stack apps, Kivi Media ships fast with vibe coding.</div><div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;"><a href="https://zivraviv.com/contact" style="padding:12px 28px;border-radius:100px;font-weight:600;font-size:0.9rem;text-decoration:none;${S.font}background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);color:#fff;display:inline-block;">Talk to Ziv</a><a href="https://github.com/kivimedia" target="_blank" rel="noopener" style="padding:12px 28px;border-radius:100px;font-weight:600;font-size:0.9rem;text-decoration:none;${S.font}background:transparent;color:#9090a8;border:1px solid #2a2a3a;display:inline-block;">View GitHub</a></div></div></div></div>`);

  // FOOTER
  parts.push(`<div style="border-top:1px solid #2a2a3a;padding:32px 0;text-align:center;color:#606078;font-size:0.8rem;"><div style="${S.container}"><div style="color:#606078;margin:0;padding:0;">Built by <a href="https://zivraviv.com" style="color:#9090a8;text-decoration:none;">Kivi Media</a> &middot; Designed by AI agents &middot; Powered by vibe coding</div></div></div>`);

  parts.push(`</div>`);

  return parts.join('');
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
