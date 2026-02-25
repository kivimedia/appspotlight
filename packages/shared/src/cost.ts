import type { CostData } from './types.js';

// Anthropic pricing as of Feb 2026 (USD per million tokens)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
};

// Fallback pricing for unknown models
const DEFAULT_PRICING = { input: 3.0, output: 15.0 };

// Estimated compute cost per second for Playwright screenshots
const SCREENSHOT_COST_PER_SEC = 0.001; // ~$0.001/sec

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  screenshotDurationSec: number
): CostData {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;

  const claudeCost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  const screenshotCost = screenshotDurationSec * SCREENSHOT_COST_PER_SEC;

  return {
    claude_input_tokens: inputTokens,
    claude_output_tokens: outputTokens,
    claude_model_used: model,
    claude_cost_usd: Math.round(claudeCost * 1_000_000) / 1_000_000, // 6 decimal precision
    screenshot_duration_sec: screenshotDurationSec,
    screenshot_cost_usd: Math.round(screenshotCost * 1_000_000) / 1_000_000,
    total_cost_usd: Math.round((claudeCost + screenshotCost) * 1_000_000) / 1_000_000,
  };
}

export function formatCostUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function selectModel(linesOfCode: number, opusThreshold: number, defaultModel: string, opusModel: string): string {
  return linesOfCode > opusThreshold ? opusModel : defaultModel;
}
