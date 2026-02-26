import { createLogger, getConfig } from '@appspotlight/shared';
import type { WPPageResult, WPMediaResult, ScreenshotResult } from '@appspotlight/shared';

const log = createLogger('wp-client');

interface WPApiOptions {
  method?: string;
  body?: unknown;
  contentType?: string;
}

async function wpFetch<T>(endpoint: string, options: WPApiOptions = {}): Promise<T> {
  const config = getConfig();
  const { method = 'GET', body, contentType } = options;

  const url = `${config.wordpress.baseUrl}/wp-json/wp/v2${endpoint}`;
  const auth = Buffer.from(`${config.wordpress.username}:${config.wordpress.appPassword}`).toString('base64');

  const headers: Record<string, string> = {
    'Authorization': `Basic ${auth}`,
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  } else if (body && !(body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
    body: body instanceof Buffer
      ? body
      : body
        ? JSON.stringify(body)
        : undefined,
  };

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WordPress API error ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export async function findPageBySlug(slug: string): Promise<{ id: number; link: string } | null> {
  const pages = await wpFetch<Array<{ id: number; link: string }>>(
    `/pages?slug=${encodeURIComponent(slug)}&status=any`
  );
  return pages.length > 0 ? pages[0] : null;
}

export async function createPage(
  title: string,
  slug: string,
  content: string,
  status: 'publish' | 'draft',
  parentId?: number
): Promise<WPPageResult> {
  const body: Record<string, unknown> = {
    title,
    slug,
    content,
    status,
  };

  if (parentId) body.parent = parentId;

  const result = await wpFetch<{ id: number; link: string; status: string }>(
    '/pages',
    { method: 'POST', body }
  );

  log.info(`Created page: ${result.link} (${result.status})`);

  return {
    pageId: result.id,
    pageUrl: result.link,
    status: result.status as 'publish' | 'draft',
    action: 'created',
  };
}

export async function updatePage(
  pageId: number,
  title: string,
  content: string,
  status: 'publish' | 'draft'
): Promise<WPPageResult> {
  const result = await wpFetch<{ id: number; link: string; status: string }>(
    `/pages/${pageId}`,
    { method: 'PUT', body: { title, content, status } }
  );

  log.info(`Updated page: ${result.link} (${result.status})`);

  return {
    pageId: result.id,
    pageUrl: result.link,
    status: result.status as 'publish' | 'draft',
    action: 'updated',
  };
}

export async function publishDraftPage(pageId: number): Promise<WPPageResult> {
  const result = await wpFetch<{ id: number; link: string; status: string }>(
    `/pages/${pageId}`,
    { method: 'PUT', body: { status: 'publish' } }
  );

  log.info(`Published draft page: ${result.link}`);

  return {
    pageId: result.id,
    pageUrl: result.link,
    status: 'publish',
    action: 'updated',
  };
}

export async function revertToDraft(pageId: number): Promise<WPPageResult> {
  const result = await wpFetch<{ id: number; link: string; status: string }>(
    `/pages/${pageId}`,
    { method: 'PUT', body: { status: 'draft' } }
  );

  log.info(`Reverted page to draft: ${result.link}`);

  return {
    pageId: result.id,
    pageUrl: result.link,
    status: 'draft',
    action: 'updated',
  };
}

export async function fetchChildPages(parentSlug: string): Promise<Array<{ id: number; link: string; title: string; content: string; status: string }>> {
  // First find the parent page ID
  const parent = await findPageBySlug(parentSlug);
  if (!parent) return [];

  const pages = await wpFetch<Array<{ id: number; link: string; title: { rendered: string }; content: { rendered: string }; status: string }>>(
    `/pages?parent=${parent.id}&per_page=100&status=any`
  );

  return pages.map(p => ({
    id: p.id,
    link: p.link,
    title: p.title.rendered,
    content: p.content.rendered,
    status: p.status,
  }));
}

// ─── Media ──────────────────────────────────────────────────────────────────

export async function uploadMedia(
  screenshot: ScreenshotResult
): Promise<WPMediaResult> {
  const config = getConfig();
  const url = `${config.wordpress.baseUrl}/wp-json/wp/v2/media`;
  const auth = Buffer.from(`${config.wordpress.username}:${config.wordpress.appPassword}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'image/webp',
      'Content-Disposition': `attachment; filename="${screenshot.filename}"`,
    },
    body: screenshot.buffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Media upload failed ${response.status}: ${errorText}`);
  }

  const result = await response.json() as { id: number; source_url: string };

  log.info(`Uploaded media: ${screenshot.filename} → ID ${result.id}`);

  return {
    mediaId: result.id,
    sourceUrl: result.source_url,
  };
}

export async function uploadAllScreenshots(
  screenshots: ScreenshotResult[]
): Promise<WPMediaResult[]> {
  const results: WPMediaResult[] = [];

  for (const screenshot of screenshots) {
    try {
      // Convert SVG placeholders to WebP before upload
      let uploadScreenshot = screenshot;
      if (screenshot.filename.endsWith('.webp') && screenshot.buffer.toString().startsWith('<svg')) {
        // Skip SVG placeholders — they need Sharp conversion
        // For now, just upload as-is and let WP handle it
        log.warn(`Skipping SVG placeholder: ${screenshot.filename}`);
        continue;
      }

      const result = await uploadMedia(uploadScreenshot);
      results.push(result);
    } catch (e) {
      log.error(`Failed to upload ${screenshot.filename}: ${(e as Error).message}`);
    }
  }

  return results;
}

// ─── Apps Index Page ────────────────────────────────────────────────────────

export async function getAppsParentPageId(): Promise<number | null> {
  const config = getConfig();
  const page = await findPageBySlug(config.wordpress.appsParentSlug);
  return page?.id ?? null;
}
