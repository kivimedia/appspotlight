import sharp from 'sharp';
import type { ScreenshotResult, ProjectType } from '@appspotlight/shared';
import { createLogger } from '@appspotlight/shared';

const log = createLogger('branded-placeholder');

// Color scheme per project type
const TYPE_STYLES: Record<ProjectType, { badge: string; glow: string; label: string }> = {
  'web-app':          { badge: '#0078FF', glow: 'rgba(0, 120, 255, 0.3)',   label: 'WEB APP' },
  'cli-tool':         { badge: '#51CF66', glow: 'rgba(81, 207, 102, 0.3)',  label: 'CLI TOOL' },
  'automation':       { badge: '#FF6B6B', glow: 'rgba(255, 107, 107, 0.3)', label: 'AUTOMATION' },
  'desktop-app':      { badge: '#845EF7', glow: 'rgba(132, 94, 247, 0.3)', label: 'DESKTOP APP' },
  'vscode-extension': { badge: '#339AF0', glow: 'rgba(51, 154, 240, 0.3)', label: 'VS CODE EXTENSION' },
  'library':          { badge: '#FCC419', glow: 'rgba(252, 196, 25, 0.3)', label: 'LIBRARY' },
};

function escSvg(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate a professional branded card image for non-web projects.
 * Uses Sharp SVG overlay → WebP output. No new dependencies needed.
 */
export async function generateBrandedPlaceholder(
  appName: string,
  repoName: string,
  projectType: ProjectType,
  description?: string | null,
  techStack?: string[]
): Promise<ScreenshotResult[]> {
  const colors = TYPE_STYLES[projectType] ?? TYPE_STYLES['web-app'];

  // Truncate text to fit
  const displayName = appName.length > 30 ? appName.substring(0, 27) + '...' : appName;
  const desc = (description ?? '').length > 80
    ? (description ?? '').substring(0, 77) + '...'
    : (description ?? '');

  // Build tech stack badge SVGs
  const techBadges = (techStack ?? []).slice(0, 6);
  const badgeWidth = 120;
  const badgeGap = 12;
  const totalBadgesWidth = techBadges.length * badgeWidth + (techBadges.length - 1) * badgeGap;
  const badgeStartX = (1440 - totalBadgesWidth) / 2;

  const techBadgeSvg = techBadges.map((tech, i) => {
    const x = badgeStartX + i * (badgeWidth + badgeGap);
    const truncTech = tech.length > 12 ? tech.substring(0, 10) + '..' : tech;
    return `<rect x="${x}" y="580" width="${badgeWidth}" height="36" rx="18" fill="#1e2440" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    <text x="${x + badgeWidth / 2}" y="603" font-family="sans-serif" font-size="14" fill="#d1d5e8" text-anchor="middle" font-weight="500">${escSvg(truncTech)}</text>`;
  }).join('\n');

  // Type badge dimensions
  const badgeLabelWidth = colors.label.length * 11 + 40;
  const badgeLabelX = (1440 - badgeLabelWidth) / 2;

  const svg = `<svg width="1440" height="900" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0a0e1a"/>
        <stop offset="100%" style="stop-color:#131829"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="40" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>

    <!-- Background -->
    <rect width="1440" height="900" fill="url(#bg)"/>

    <!-- Decorative glow circle -->
    <circle cx="720" cy="350" r="200" fill="${colors.glow}" filter="url(#glow)" opacity="0.5"/>

    <!-- Border -->
    <rect x="40" y="40" width="1360" height="820" rx="24" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

    <!-- Project type badge -->
    <rect x="${badgeLabelX}" y="240" width="${badgeLabelWidth}" height="40" rx="20" fill="${colors.badge}"/>
    <text x="720" y="266" font-family="sans-serif" font-size="15" fill="#ffffff" text-anchor="middle" font-weight="700" letter-spacing="2">${escSvg(colors.label)}</text>

    <!-- App name -->
    <text x="720" y="370" font-family="sans-serif" font-size="64" fill="#ffffff" text-anchor="middle" font-weight="900">${escSvg(displayName)}</text>

    <!-- Description -->
    ${desc ? `<text x="720" y="430" font-family="sans-serif" font-size="22" fill="#9CA3BE" text-anchor="middle" font-weight="400">${escSvg(desc)}</text>` : ''}

    <!-- Divider line -->
    <line x1="570" y1="490" x2="870" y2="490" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

    <!-- Tech stack label -->
    ${techBadges.length > 0 ? `<text x="720" y="545" font-family="sans-serif" font-size="13" fill="#6C63FF" text-anchor="middle" font-weight="700" letter-spacing="2">BUILT WITH</text>` : ''}

    <!-- Tech badges -->
    ${techBadgeSvg}

    <!-- Footer branding -->
    <text x="720" y="800" font-family="sans-serif" font-size="14" fill="rgba(255,255,255,0.25)" text-anchor="middle">zivraviv.com/apps</text>
  </svg>`;

  // Render SVG to WebP using Sharp
  const buffer = await sharp(Buffer.from(svg))
    .resize({ width: 1440 })
    .webp({ quality: 90 })
    .toBuffer();

  log.info(`Generated branded card for "${appName}" (${colors.label}): ${(buffer.length / 1024).toFixed(1)}KB`);

  return [{
    buffer,
    filename: `${repoName}-branded-card.webp`,
    label: `${colors.label} Overview`,
    viewport: 'desktop' as const,
    sizeKb: buffer.length / 1024,
  }];
}
