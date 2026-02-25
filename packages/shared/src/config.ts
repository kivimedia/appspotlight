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
    deployUrlMap: defaults.deployUrlMap,
  };

  return _config;
}

/** Reset cached config (useful for testing) */
export function resetConfig(): void {
  _config = null;
}
