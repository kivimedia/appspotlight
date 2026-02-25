import { createHmac, timingSafeEqual } from 'crypto';
import { createLogger, getConfig } from '@appspotlight/shared';
import type { GitHubEvent } from '@appspotlight/shared';

const log = createLogger('webhook');

// In-memory cooldown tracker (repo → last trigger time)
const cooldowns = new Map<string, number>();

const DEPENDENCY_ONLY_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.gitignore',
  '.eslintrc',
  '.prettierrc',
]);

/**
 * Validate GitHub webhook signature.
 */
export function validateSignature(payload: string, signature: string | undefined): boolean {
  const config = getConfig();
  if (!config.github.webhookSecret) {
    log.warn('No webhook secret configured — skipping signature validation');
    return true;
  }

  if (!signature) {
    log.error('Missing X-Hub-Signature-256 header');
    return false;
  }

  const expected = 'sha256=' + createHmac('sha256', config.github.webhookSecret)
    .update(payload)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Parse a GitHub webhook payload into our GitHubEvent type.
 * Returns null if the event should be ignored.
 */
export function parseWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>
): GitHubEvent | null {
  const config = getConfig();

  if (eventType === 'repository') {
    const repo = payload.repository as Record<string, unknown>;
    if (payload.action !== 'created' && payload.action !== 'publicized') {
      log.info(`Ignoring repository event: ${payload.action}`);
      return null;
    }

    const repoName = repo.name as string;
    if (config.github.excludedRepos.includes(repoName)) {
      log.info(`Repo "${repoName}" is in exclusion list`);
      return null;
    }

    return {
      eventType: 'repository',
      repoName,
      repoUrl: repo.html_url as string,
      cloneUrl: repo.clone_url as string,
      branch: repo.default_branch as string ?? 'main',
      commitSha: null,
      releaseTag: null,
      filesChanged: 0,
      changedFiles: [],
      senderLogin: (payload.sender as Record<string, unknown>)?.login as string ?? 'unknown',
    };
  }

  if (eventType === 'push') {
    const repo = payload.repository as Record<string, unknown>;
    const repoName = repo.name as string;
    const ref = payload.ref as string;
    const branch = ref.replace('refs/heads/', '');

    // Check branch
    if (!config.github.allowedBranches.includes(branch)) {
      log.info(`Ignoring push to branch "${branch}" (not in allowed list)`);
      return null;
    }

    if (config.github.excludedRepos.includes(repoName)) {
      log.info(`Repo "${repoName}" is in exclusion list`);
      return null;
    }

    // Get changed files
    const commits = (payload.commits as Array<Record<string, unknown>>) ?? [];
    const changedFiles = new Set<string>();
    for (const commit of commits) {
      for (const f of (commit.added as string[] ?? [])) changedFiles.add(f);
      for (const f of (commit.modified as string[] ?? [])) changedFiles.add(f);
      for (const f of (commit.removed as string[] ?? [])) changedFiles.add(f);
    }

    const changedArr = [...changedFiles];

    // Filter: dependency-only commits
    const realChanges = changedArr.filter(f => !DEPENDENCY_ONLY_FILES.has(f));
    if (realChanges.length === 0) {
      log.info('Ignoring dependency-only commit');
      return null;
    }

    // Filter: minimum file changes
    if (realChanges.length < config.pipeline.minFileChangesForUpdate) {
      log.info(`Only ${realChanges.length} non-dependency files changed (min: ${config.pipeline.minFileChangesForUpdate})`);
      return null;
    }

    return {
      eventType: 'push',
      repoName,
      repoUrl: repo.html_url as string,
      cloneUrl: repo.clone_url as string,
      branch,
      commitSha: payload.after as string ?? null,
      releaseTag: null,
      filesChanged: changedArr.length,
      changedFiles: changedArr,
      senderLogin: (payload.sender as Record<string, unknown>)?.login as string ?? 'unknown',
    };
  }

  if (eventType === 'release') {
    const repo = payload.repository as Record<string, unknown>;
    const release = payload.release as Record<string, unknown>;
    const repoName = repo.name as string;

    if (payload.action !== 'published') {
      log.info(`Ignoring release event: ${payload.action}`);
      return null;
    }

    if (config.github.excludedRepos.includes(repoName)) {
      log.info(`Repo "${repoName}" is in exclusion list`);
      return null;
    }

    return {
      eventType: 'release',
      repoName,
      repoUrl: repo.html_url as string,
      cloneUrl: repo.clone_url as string,
      branch: repo.default_branch as string ?? 'main',
      commitSha: null,
      releaseTag: release.tag_name as string ?? null,
      filesChanged: 0,
      changedFiles: [],
      senderLogin: (payload.sender as Record<string, unknown>)?.login as string ?? 'unknown',
    };
  }

  log.info(`Ignoring event type: ${eventType}`);
  return null;
}

/**
 * Check and enforce cooldown per repo.
 */
export function checkCooldown(repoName: string): boolean {
  const config = getConfig();
  const cooldownMs = config.pipeline.cooldownMinutes * 60 * 1000;
  const lastTrigger = cooldowns.get(repoName);

  if (lastTrigger && Date.now() - lastTrigger < cooldownMs) {
    const remainingMin = ((cooldownMs - (Date.now() - lastTrigger)) / 60000).toFixed(1);
    log.info(`Cooldown active for "${repoName}" (${remainingMin}min remaining)`);
    return false;
  }

  cooldowns.set(repoName, Date.now());
  return true;
}
