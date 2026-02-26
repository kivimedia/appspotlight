import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import type { AppSpotlightConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
dotenvConfig({ path: resolve(__dirname, '../../../.env') });

function loadDefaultConfig(): AppSpotlightConfig {
  const configPath = resolve(__dirname, '../../../config/default.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? Number(v) : fallback;
}

function envList(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

let _config: AppSpotlightConfig | null = null;

export function getConfig(): AppSpotlightConfig {
  if (_config) return _config;

  const defaults = loadDefaultConfig();

  _config = {
    github: {
      webhookSecret: envStr('GITHUB_WEBHOOK_SECRET', defaults.github.webhookSecret),
      token: envStr('GITHUB_TOKEN', defaults.github.token),
      excludedRepos: envList('EXCLUDED_REPOS', defaults.github.excludedRepos),
      allowedBranches: envList('ALLOWED_BRANCHES', defaults.github.allowedBranches),
    },
    claude: {
      apiKey: envStr('CLAUDE_API_KEY', defaults.claude.apiKey),
      defaultModel: envStr('CLAUDE_MODEL', defaults.claude.defaultModel),
      opusModel: defaults.claude.opusModel,
      opusThreshold: envNum('OPUS_THRESHOLD', defaults.claude.opusThreshold),
      maxInputTokens: defaults.claude.maxInputTokens,
      maxOutputTokens: defaults.claude.maxOutputTokens,
    },
    wordpress: {
      baseUrl: envStr('WP_BASE_URL', defaults.wordpress.baseUrl),
      username: envStr('WP_USERNAME', defaults.wordpress.username),
      appPassword: envStr('WP_APP_PASSWORD', defaults.wordpress.appPassword),
      appsParentSlug: defaults.wordpress.appsParentSlug,
    },
    supabase: {
      url: envStr('DATABASE_URL', envStr('SUPABASE_URL', defaults.supabase.url)),
      serviceKey: envStr('SUPABASE_SERVICE_KEY', defaults.supabase.serviceKey),
    },
    pipeline: {
      cooldownMinutes: envNum('COOLDOWN_MINUTES', defaults.pipeline.cooldownMinutes),
      autoPublishThreshold: envNum('AUTO_PUBLISH_THRESHOLD', defaults.pipeline.autoPublishThreshold),
      minFileChangesForUpdate: defaults.pipeline.minFileChangesForUpdate,
    },
    screenshots: { ...defaults.screenshots },
    budget: {
      maxCostPerRun: envNum('MAX_COST_PER_RUN', defaults.budget.maxCostPerRun),
      maxWeeklyBudget: envNum('MAX_WEEKLY_BUDGET', defaults.budget.maxWeeklyBudget),
      maxMonthlyBudget: envNum('MAX_MONTHLY_BUDGET', defaults.budget.maxMonthlyBudget),
      alertAtPercent: envNum('ALERT_AT_PERCENT', defaults.budget.alertAtPercent),
    },
    watcher: {
      port: envNum('WATCHER_PORT', defaults.watcher.port),
    },
    vercel: {
      token: envStr('VERCEL_TOKEN', defaults.vercel?.token ?? ''),
      teamId: envStr('VERCEL_TEAM_ID', defaults.vercel?.teamId ?? '') || undefined,
    },
    deployUrlMap: defaults.deployUrlMap,
    appAuth: defaults.appAuth ?? {},
    visualQA: {
      enabled: process.env.VISUAL_QA_ENABLED !== 'false' && (defaults.visualQA?.enabled ?? true),
      model: envStr('VISUAL_QA_MODEL', defaults.visualQA?.model ?? 'claude-sonnet-4-5-20250929'),
      maxTokens: envNum('VISUAL_QA_MAX_TOKENS', defaults.visualQA?.maxTokens ?? 1500),
      failOnCritical: defaults.visualQA?.failOnCritical ?? true,
      failThreshold: envNum('VISUAL_QA_FAIL_THRESHOLD', defaults.visualQA?.failThreshold ?? 3),
      retryEnabled: process.env.VISUAL_QA_RETRY_ENABLED !== 'false' && (defaults.visualQA?.retryEnabled ?? true),
      maxRetries: Math.min(envNum('VISUAL_QA_MAX_RETRIES', defaults.visualQA?.maxRetries ?? 1), 3),
      retryableCategories: defaults.visualQA?.retryableCategories ?? ['content', 'readability'],
    },
  };

  return _config;
}

/** Reset cached config (useful for testing) */
export function resetConfig(): void {
  _config = null;
}

/** Resolve app auth credentials from env vars (APP_AUTH_{REPO}_EMAIL / _PASSWORD) */
export function getAppAuthCredentials(repoName: string): { email: string; password: string } | null {
  const key = repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const email = process.env[`APP_AUTH_${key}_EMAIL`];
  const password = process.env[`APP_AUTH_${key}_PASSWORD`];
  if (!email || !password) return null;
  return { email, password };
}
