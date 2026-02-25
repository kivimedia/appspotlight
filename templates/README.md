# AppSpotlight Templates

## Files

### `one-pager-reference.html`
Static HTML reference of the ChoirMind one-pager design. This is the visual target that the Gutenberg block template in `packages/publisher/src/page-template.ts` aims to match.

Open this file in a browser to see the intended design with all 7 sections:
1. Hero (app name, tagline, CTA)
2. Problem / Solution (two-column cards)
3. Feature Cards (2x2 grid)
4. Screenshot Gallery
5. Who It's For (audience cards)
6. Tech Stack Badges
7. CTA Section

## How the template system works

The actual page generation happens in `packages/publisher/src/page-template.ts`:
- `generatePageMarkup()` takes structured `AppContent` + uploaded media and produces Gutenberg block HTML
- Each section is built by a dedicated function (buildHeroSection, buildFeaturesSection, etc.)
- The template uses native WordPress blocks only (no Kadence or Divi)
- Dark theme styling is inline (works with any WordPress theme)

## Customizing

To change the page structure, edit `page-template.ts`. The HTML reference is for visual comparison only.
