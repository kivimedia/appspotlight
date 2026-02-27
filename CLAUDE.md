# AppSpotlight — Agent Instructions

## Project Overview
Monorepo that auto-generates portfolio pages for Kivi Media apps on zivraviv.com (WordPress + Divi theme).

**Packages**: shared, analyst, publisher, watcher
**Target site**: zivraviv.com (WordPress, Divi theme)
**Database**: Neon PostgreSQL (`withered-flower-05679276`)
**Build order**: `npm run build -w @appspotlight/shared` first, then other packages

## Two Page Types

### 1. Portfolio Index (`/apps/`, page ID 1905)
- **Template**: `scripts/update-portfolio.ts` → raw HTML in `wp:html` block
- **Strategy**: Fully inline styles with CSS custom properties for responsive
- **Run**: `npx tsx scripts/update-portfolio.ts`

### 2. Individual App Pages (16 pages)
- **Template**: `packages/publisher/src/page-template.ts` → Gutenberg blocks
- **Strategy**: `clamp()` for font sizing + `@media` queries in global `<style>` block
- **Republish all**: `npx tsx scripts/republish-template.ts` (no AI cost, ~60s)
- **Full pipeline**: `npx tsx scripts/backfill.ts ZivRaviv` (AI analysis, screenshots, expensive)

## WordPress + Divi Critical Rules

These rules are MANDATORY. Violating them will break the page layout.

### Portfolio Page (raw HTML)
1. **ALL layout styles MUST be inline** (`style=""`) — Divi overrides everything else
2. **NEVER use `<p>` tags** — WordPress `wpautop` wraps inline elements in `<p>`, breaking grid layouts
3. **NEVER use `<a>` as grid children** — wpautop wraps `<a>` in `<p>`. Use `<div onclick="window.location.href='...'">`
4. **NO newlines between block elements** — wpautop inserts `<p>` at blank lines. Use `parts.join('')`
5. **`<script>` tags are stripped** by WordPress — use inline `onclick` handlers
6. **`<style>` block is ONLY for**: hover effects, `@media` queries, `@keyframes`, pseudo-elements
7. **CSS custom properties for responsive**: Inline styles use `var(--name, fallback)`. Media queries override variables on `#kp-root`

### Individual App Pages (Gutenberg blocks)
1. Use `clamp(min, preferred, max)` for responsive font sizes in inline styles
2. Add `@media` breakpoints in the global `<style>` block (`buildGlobalStyles()`)
3. Gutenberg `wp:columns` blocks should auto-stack on mobile, but Divi may interfere — force with `flex-direction: column !important` in media query

## Fonts
- **Portfolio page**: Outfit (headings) + JetBrains Mono (accents)
- **Individual pages**: Poppins (headings) + Open Sans (body)
- **NEVER** use Arial, system fonts, or any other font
- Always load via Google Fonts with `preconnect` hints

## Mobile Testing Checklist

Run this checklist after ANY template change before considering the task complete.

### Quick Verification
1. Open Chrome DevTools → Toggle device toolbar (Ctrl+Shift+M)
2. Test at these widths: **375px** (iPhone SE), **768px** (iPad), **1440px** (desktop)
3. Check for:
   - No horizontal scrollbar at any width
   - Text readable without pinch-zooming
   - Grids stack to single column at 375px
   - Images scale proportionally
   - Buttons/links have adequate tap targets (min 44px)
   - Filter buttons wrap properly on narrow screens

### PageSpeed Verification
1. Run https://pagespeed.web.dev/ on the page URL
2. Target: **90+ mobile score**
3. Common issues to check:
   - LCP image: Must have `loading="eager"` + `fetchpriority="high"` (not `loading="lazy"`)
   - All images: Must have `width` and `height` attributes (prevents CLS)
   - Google Fonts: Must have `<link rel="preconnect">` hints
   - No render-blocking resources

### Pages to Test
- Portfolio: https://zivraviv.com/apps/
- Sample app pages:
  - https://zivraviv.com/apps/inventory-plus/
  - https://zivraviv.com/deploy-helper/
  - https://zivraviv.com/karaokemadness/

### Responsive Breakpoints

**Portfolio page** (`update-portfolio.ts`):
| Breakpoint | Grid | Featured Card | Stats |
|-----------|------|---------------|-------|
| Desktop (>900px) | 3 columns | 2-column (image + text) | Row, 48px gap |
| Tablet (≤900px) | 2 columns | Stacked | Row, 32px gap |
| Mobile (≤600px) | 1 column | Stacked | Column, 16px gap |

**Individual pages** (`page-template.ts`):
| Breakpoint | Hero h1 | Section h2 | Sections | Cards |
|-----------|---------|------------|----------|-------|
| Desktop | 3.5rem | 2.2rem | 4rem padding | 2rem padding |
| Tablet (≤1024px) | scales via clamp | scales via clamp | 4rem padding | 2rem padding |
| Mobile (≤767px) | 1.8rem min | 1.5rem min | 2.5rem padding | 1.5rem padding |

## Scripts Reference

| Script | Purpose | Cost |
|--------|---------|------|
| `update-portfolio.ts` | Regenerate /apps/ index page | Free |
| `republish-template.ts` | Re-render all 16 app pages (template-only) | Free |
| `backfill.ts ZivRaviv` | Full pipeline: analyze + publish all repos | AI API cost |
| `run-manual.ts` | Single repo pipeline run | AI API cost |
| `capture-wp-edits.ts` | Capture human edits from WP | Free |
