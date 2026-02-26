import pg from 'pg';
const { Pool } = pg;
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import type { RunRecord, CostData, AppContent, HumanEdit } from './types.js';

const log = createLogger('database');

let _pool: pg.Pool | null = null;

export function getDbPool(): pg.Pool | null {
  if (_pool) return _pool;

  const config = getConfig();
  if (!config.supabase.url) {
    log.warn('DATABASE_URL not configured — pipeline runs will not be logged to DB');
    return null;
  }

  _pool = new Pool({
    connectionString: config.supabase.url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
  return _pool;
}

/** @deprecated Use getDbPool() — kept for backward compat */
export const getSupabaseClient = getDbPool;

// ─── Pipeline Run Logging ───────────────────────────────────────────────────

export async function createRunRecord(
  runId: string,
  repoName: string,
  eventType: RunRecord['event_type']
): Promise<void> {
  const pool = getDbPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO pipeline_runs (
        run_id, repo_name, event_type, status, started_at,
        auto_check_failures, human_edits, retry_qa_failures,
        claude_input_tokens, claude_output_tokens, claude_model_used,
        claude_cost_usd, screenshot_duration_sec, screenshot_cost_usd, total_cost_usd,
        retry_count, retry_cost_usd,
        visual_qa_retry_count, visual_qa_retry_cost_usd
      ) VALUES ($1, $2, $3, 'running', NOW(), '{}', '[]', '{}', 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0)`,
      [runId, repoName, eventType]
    );
  } catch (err) {
    log.error('Failed to create run record', { error: (err as Error).message });
  }
}

export async function updateRunRecord(
  runId: string,
  updates: Partial<RunRecord>
): Promise<void> {
  const pool = getDbPool();
  if (!pool) return;

  // Build dynamic SET clause from the updates object
  const entries = Object.entries(updates).filter(([_, v]) => v !== undefined);
  if (entries.length === 0) return;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const [key, value] of entries) {
    if (key === 'auto_check_failures' || key === 'retry_qa_failures' || key === 'visual_qa_issues') {
      setClauses.push(`${key} = $${paramIdx}::text[]`);
    } else if (key === 'human_edits' || key === 'generated_content') {
      setClauses.push(`${key} = $${paramIdx}::jsonb`);
      values.push(JSON.stringify(value));
      paramIdx++;
      continue;
    } else if (key === 'screenshot_duration_sec') {
      // Cast float to numeric to avoid integer type mismatch
      setClauses.push(`${key} = $${paramIdx}::numeric`);
    } else {
      setClauses.push(`${key} = $${paramIdx}`);
    }
    values.push(value);
    paramIdx++;
  }

  values.push(runId);

  try {
    await pool.query(
      `UPDATE pipeline_runs SET ${setClauses.join(', ')} WHERE run_id = $${paramIdx}`,
      values
    );
  } catch (err) {
    log.error('Failed to update run record', { error: (err as Error).message });
  }
}

export async function completeRunRecord(
  runId: string,
  costData: CostData,
  pageResult: { pageId: number; pageUrl: string; status: string } | null,
  confidence: number,
  qaResult: { passed: boolean; failures: string[] },
  generatedContent?: AppContent | null,
  visualQA?: { passed: boolean; issues: string[]; cost_usd: number } | null
): Promise<void> {
  const publishAction = pageResult
    ? (pageResult.status === 'publish' ? 'auto_published' : 'draft_approved')
    : null;

  const updates: Partial<RunRecord> = {
    status: 'completed',
    completed_at: new Date().toISOString(),
    confidence_score: confidence,
    auto_checks_passed: qaResult.passed,
    auto_check_failures: qaResult.failures,
    publish_action: publishAction as RunRecord['publish_action'],
    wp_page_id: pageResult?.pageId ?? null,
    wp_page_url: pageResult?.pageUrl ?? null,
    ...costData,
  };

  if (generatedContent) {
    updates.generated_content = generatedContent;
  }

  if (visualQA) {
    updates.visual_qa_passed = visualQA.passed;
    updates.visual_qa_issues = visualQA.issues;
    updates.visual_qa_cost_usd = visualQA.cost_usd;
  }

  await updateRunRecord(runId, updates);
}

export async function failRunRecord(runId: string, errorMessage: string): Promise<void> {
  await updateRunRecord(runId, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error_message: errorMessage,
  });
}

// ─── Budget Checks ──────────────────────────────────────────────────────────

export async function getWeeklySpend(): Promise<number> {
  const pool = getDbPool();
  if (!pool) return 0;

  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as total
       FROM pipeline_runs
       WHERE started_at >= NOW() - INTERVAL '7 days'
         AND status = 'completed'`
    );
    return parseFloat(result.rows[0]?.total ?? '0');
  } catch (err) {
    log.error('Failed to get weekly spend', { error: (err as Error).message });
    return 0;
  }
}

export async function getMonthlySpend(): Promise<number> {
  const pool = getDbPool();
  if (!pool) return 0;

  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as total
       FROM pipeline_runs
       WHERE started_at >= DATE_TRUNC('month', NOW())
         AND status = 'completed'`
    );
    return parseFloat(result.rows[0]?.total ?? '0');
  } catch (err) {
    log.error('Failed to get monthly spend', { error: (err as Error).message });
    return 0;
  }
}

export async function checkBudget(): Promise<{ allowed: boolean; reason?: string }> {
  const config = getConfig();
  const weeklySpend = await getWeeklySpend();
  const monthlySpend = await getMonthlySpend();

  if (monthlySpend >= config.budget.maxMonthlyBudget) {
    return { allowed: false, reason: `Monthly budget exceeded: $${monthlySpend.toFixed(2)} >= $${config.budget.maxMonthlyBudget}` };
  }

  if (weeklySpend >= config.budget.maxWeeklyBudget) {
    return { allowed: false, reason: `Weekly budget exceeded: $${weeklySpend.toFixed(2)} >= $${config.budget.maxWeeklyBudget}` };
  }

  const weeklyPct = (weeklySpend / config.budget.maxWeeklyBudget) * 100;
  const monthlyPct = (monthlySpend / config.budget.maxMonthlyBudget) * 100;

  if (weeklyPct >= config.budget.alertAtPercent) {
    log.warn(`Weekly budget at ${weeklyPct.toFixed(0)}% ($${weeklySpend.toFixed(2)}/$${config.budget.maxWeeklyBudget})`);
  }
  if (monthlyPct >= config.budget.alertAtPercent) {
    log.warn(`Monthly budget at ${monthlyPct.toFixed(0)}% ($${monthlySpend.toFixed(2)}/$${config.budget.maxMonthlyBudget})`);
  }

  return { allowed: true };
}

// ─── Query helper for scripts ───────────────────────────────────────────────

export async function queryRuns(since: Date): Promise<RunRecord[]> {
  const pool = getDbPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT run_id, repo_name, status, event_type, confidence_score,
              claude_model_used, claude_cost_usd, screenshot_cost_usd,
              total_cost_usd, started_at, completed_at
       FROM pipeline_runs
       WHERE started_at >= $1
       ORDER BY started_at DESC`,
      [since.toISOString()]
    );
    return result.rows;
  } catch (err) {
    log.error('Failed to query runs', { error: (err as Error).message });
    return [];
  }
}

// ─── Feedback Loop Queries ─────────────────────────────────────────────────

export async function getRunById(runId: string): Promise<(RunRecord & { generated_content: AppContent | null }) | null> {
  const pool = getDbPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT * FROM pipeline_runs WHERE run_id = $1`,
      [runId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      ...row,
      generated_content: row.generated_content ?? null,
      human_edits: row.human_edits ?? [],
      auto_check_failures: row.auto_check_failures ?? [],
      retry_qa_failures: row.retry_qa_failures ?? [],
    };
  } catch (err) {
    log.error('Failed to get run by ID', { error: (err as Error).message });
    return null;
  }
}

export async function getDraftRuns(): Promise<RunRecord[]> {
  const pool = getDbPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT run_id, repo_name, confidence_score, auto_check_failures,
              wp_page_id, wp_page_url, started_at, publish_action
       FROM pipeline_runs
       WHERE status = 'completed'
         AND wp_page_id IS NOT NULL
         AND (publish_action IS NULL OR publish_action NOT IN ('auto_published', 'draft_approved', 'rejected'))
       ORDER BY started_at DESC`
    );
    return result.rows;
  } catch (err) {
    log.error('Failed to get draft runs', { error: (err as Error).message });
    return [];
  }
}

export async function getRunsWithEdits(since: Date): Promise<Array<{
  run_id: string;
  repo_name: string;
  human_edits: HumanEdit[];
  auto_check_failures: string[];
  generated_content: AppContent | null;
}>> {
  const pool = getDbPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT run_id, repo_name, human_edits, auto_check_failures, generated_content
       FROM pipeline_runs
       WHERE started_at >= $1
         AND status = 'completed'
         AND (human_edits != '[]'::jsonb OR array_length(auto_check_failures, 1) > 0)
       ORDER BY started_at DESC`,
      [since.toISOString()]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      run_id: row.run_id as string,
      repo_name: row.repo_name as string,
      human_edits: (row.human_edits as HumanEdit[]) ?? [],
      auto_check_failures: (row.auto_check_failures as string[]) ?? [],
      generated_content: (row.generated_content as AppContent) ?? null,
    }));
  } catch (err) {
    log.error('Failed to get runs with edits', { error: (err as Error).message });
    return [];
  }
}

export async function getRunByWpPageId(wpPageId: number): Promise<(RunRecord & { generated_content: AppContent | null }) | null> {
  const pool = getDbPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT * FROM pipeline_runs
       WHERE wp_page_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [wpPageId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      ...row,
      generated_content: row.generated_content ?? null,
      human_edits: row.human_edits ?? [],
      auto_check_failures: row.auto_check_failures ?? [],
      retry_qa_failures: row.retry_qa_failures ?? [],
    };
  } catch (err) {
    log.error('Failed to get run by WP page ID', { error: (err as Error).message });
    return null;
  }
}
