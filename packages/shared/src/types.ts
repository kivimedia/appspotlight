// ─── Pipeline Data Types ────────────────────────────────────────────────────

export interface AppContent {
  app_name: string;
  tagline: string;
  problem_statement: string;
  target_audience: string;
  features: AppFeature[];
  benefits: string[];
  tech_stack: string[];
  cta_text: string;
  cta_url: string;
}

export interface AppFeature {
  title: string;
  description: string;
  icon?: string;
}

export interface ScreenshotResult {
  buffer: Buffer;
  filename: string;
  label: string;
  viewport: 'desktop' | 'mobile';
  sizeKb: number;
}

export interface AnalystOutput {
  content: AppContent;
  screenshots: ScreenshotResult[];
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  costData: CostData;
  repoMeta: RepoMeta;
}

export interface ConfidenceBreakdown {
  readmePresent: boolean;       // +20
  deployedUrlReachable: boolean; // +25
  featuresIdentified: boolean;   // +20 (3+ features)
  clearAudience: boolean;        // +15
  screenshotsCaptured: boolean;  // +20
  totalScore: number;
}

export interface RepoMeta {
  repoName: string;
  repoUrl: string;
  defaultBranch: string;
  linesOfCode: number;
  languages: string[];
  homepageUrl: string | null;
  description: string | null;
}

// ─── Cost Tracking ──────────────────────────────────────────────────────────

export interface CostData {
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_model_used: string;
  claude_cost_usd: number;
  screenshot_duration_sec: number;
  screenshot_cost_usd: number;
  total_cost_usd: number;
}

// ─── Pipeline Run Record ────────────────────────────────────────────────────

export interface RunRecord {
  run_id: string;
  repo_name: string;
  event_type: 'repo_created' | 'push_to_main' | 'release_published' | 'manual';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'budget_exceeded';
  confidence_score: number | null;
  auto_checks_passed: boolean | null;
  auto_check_failures: string[];
  publish_action: 'auto_published' | 'draft_approved' | 'draft_edited' | 'rejected' | null;
  wp_page_id: number | null;
  wp_page_url: string | null;
  human_edits: HumanEdit[];
  rejection_reason: string | null;

  // Cost fields
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_model_used: string;
  claude_cost_usd: number;
  screenshot_duration_sec: number;
  screenshot_cost_usd: number;
  total_cost_usd: number;

  // Feedback loop fields
  generated_content: AppContent | null;
  retry_count: number;
  retry_cost_usd: number;
  retry_qa_failures: string[];

  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export interface HumanEdit {
  field: string;
  original_value: string;
  edited_value: string;
}

// ─── Feedback Loop ──────────────────────────────────────────────────────────

export interface FeedbackContext {
  previousContent: AppContent;
  qaFailures: string[];
}

export interface ReviewAction {
  action: 'approve' | 'edit_approve' | 'reject';
  edits?: Partial<AppContent>;
  rejection_reason?: string;
}

// ─── Webhook Events ─────────────────────────────────────────────────────────

export interface GitHubEvent {
  eventType: 'repository' | 'push' | 'release';
  repoName: string;
  repoUrl: string;
  cloneUrl: string;
  branch: string;
  commitSha: string | null;
  releaseTag: string | null;
  filesChanged: number;
  changedFiles: string[];
  senderLogin: string;
}

// ─── WordPress ──────────────────────────────────────────────────────────────

export interface WPPageResult {
  pageId: number;
  pageUrl: string;
  status: 'publish' | 'draft';
  action: 'created' | 'updated';
}

export interface WPMediaResult {
  mediaId: number;
  sourceUrl: string;
}

// ─── QA ─────────────────────────────────────────────────────────────────────

export interface QACheckResult {
  passed: boolean;
  checks: QACheck[];
  failures: string[];
}

export interface QACheck {
  name: string;
  passed: boolean;
  message: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface AppSpotlightConfig {
  github: {
    webhookSecret: string;
    token: string;
    excludedRepos: string[];
    allowedBranches: string[];
  };
  claude: {
    apiKey: string;
    defaultModel: string;
    opusModel: string;
    opusThreshold: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  wordpress: {
    baseUrl: string;
    username: string;
    appPassword: string;
    appsParentSlug: string;
  };
  supabase: {
    url: string;
    serviceKey: string;
  };
  pipeline: {
    cooldownMinutes: number;
    autoPublishThreshold: number;
    minFileChangesForUpdate: number;
  };
  screenshots: {
    desktopViewport: { width: number; height: number };
    mobileViewport: { width: number; height: number };
    waitAfterLoadMs: number;
    maxScreenshots: number;
    maxFileSizeKb: number;
    maxWidthPx: number;
    format: string;
  };
  budget: {
    maxCostPerRun: number;
    maxWeeklyBudget: number;
    maxMonthlyBudget: number;
    alertAtPercent: number;
  };
  watcher: {
    port: number;
  };
  deployUrlMap: Record<string, string>;
}
