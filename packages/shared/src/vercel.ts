import { createLogger } from './logger.js';
import type { AppSpotlightConfig } from './types.js';

const log = createLogger('vercel');

/**
 * Query the Vercel API to find a production deployment URL for a given repo name.
 *
 * Searches for a Vercel project matching the repo name under the configured team,
 * then returns the production deployment domain (if any).
 *
 * Returns null if Vercel token is not configured, no project found, or any error.
 */
export async function getVercelDeploymentUrl(
  repoName: string,
  config: AppSpotlightConfig
): Promise<string | null> {
  const token = config.vercel?.token;
  if (!token) return null;

  const teamId = config.vercel?.teamId;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  try {
    // Step 1: List projects, search by repo name
    const projectUrl = new URL('https://api.vercel.com/v9/projects');
    if (teamId) projectUrl.searchParams.set('teamId', teamId);
    projectUrl.searchParams.set('search', repoName);
    projectUrl.searchParams.set('limit', '5');

    const projectRes = await fetch(projectUrl.toString(), { headers });
    if (!projectRes.ok) {
      log.warn(`Vercel API projects error: ${projectRes.status} ${projectRes.statusText}`);
      return null;
    }

    const projectData = await projectRes.json() as {
      projects: Array<{
        name: string;
        id: string;
        link?: { type: string; repo: string };
        targets?: Record<string, { alias?: string[] }>;
        alias?: Array<{ domain: string }>;
      }>;
    };

    if (!projectData.projects?.length) {
      log.info(`No Vercel project found for "${repoName}"`);
      return null;
    }

    // Find best match — prefer exact name match, then repo link match
    const project = projectData.projects.find(
      p => p.name.toLowerCase() === repoName.toLowerCase()
    ) ?? projectData.projects.find(
      p => p.link?.repo?.toLowerCase().includes(repoName.toLowerCase())
    ) ?? projectData.projects[0];

    log.info(`Found Vercel project: "${project.name}" (${project.id})`);

    // Step 2: Get production domains from the project
    const domainUrl = new URL(`https://api.vercel.com/v9/projects/${project.id}/domains`);
    if (teamId) domainUrl.searchParams.set('teamId', teamId);

    const domainRes = await fetch(domainUrl.toString(), { headers });
    if (!domainRes.ok) {
      log.warn(`Vercel API domains error: ${domainRes.status} ${domainRes.statusText}`);
      // Fallback: try to construct from project name
      return `https://${project.name}.vercel.app`;
    }

    const domainData = await domainRes.json() as {
      domains: Array<{ name: string; redirect?: string | null }>;
    };

    // Prefer custom domains (non-vercel.app), then any domain
    const customDomain = domainData.domains?.find(
      d => !d.name.endsWith('.vercel.app') && !d.redirect
    );
    const vercelDomain = domainData.domains?.find(
      d => d.name.endsWith('.vercel.app') && !d.redirect
    );

    const domain = customDomain?.name ?? vercelDomain?.name ?? `${project.name}.vercel.app`;
    const url = `https://${domain}`;

    log.info(`Vercel deployment URL for "${repoName}": ${url}`);
    return url;
  } catch (err) {
    log.warn(`Vercel API error: ${(err as Error).message}`);
    return null;
  }
}
