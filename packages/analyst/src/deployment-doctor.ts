/**
 * Deployment Doctor — SOS agent that diagnoses and fixes common deployment issues.
 *
 * When a deployed URL is unreachable or returning errors, this module:
 * 1. Fetches the URL and inspects the HTTP status + error body
 * 2. Identifies known error patterns (Next.js 16 proxy, build failures, etc.)
 * 3. If the issue has a known fix, applies it to the cloned repo
 * 4. Commits and pushes the fix, then waits for redeployment
 * 5. Returns whether the fix was applied so the pipeline can retry screenshots
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@appspotlight/shared';

const log = createLogger('deploy-doctor');

export interface DiagnosisResult {
  status: 'healthy' | 'fixable' | 'unfixable' | 'error';
  httpStatus: number | null;
  errorCode: string | null;
  diagnosis: string;
  fixApplied: boolean;
  fixDescription?: string;
}

interface FixCandidate {
  pattern: RegExp;
  diagnose: (body: string, clonePath: string) => Promise<FixAction | null>;
}

interface FixAction {
  description: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * Known fix patterns — each checks the error body for a known pattern
 * and returns a fix if applicable.
 */
const KNOWN_FIXES: FixCandidate[] = [
  {
    // Next.js 16 renamed middleware.ts to proxy.ts
    pattern: /MIDDLEWARE_INVOCATION_FAILED/i,
    diagnose: async (body: string, clonePath: string) => {
      const hasProxy = existsSync(join(clonePath, 'proxy.ts')) || existsSync(join(clonePath, 'proxy.js'));
      const hasMiddleware = existsSync(join(clonePath, 'middleware.ts')) || existsSync(join(clonePath, 'middleware.js'));

      if (hasProxy || hasMiddleware) return null;

      // Check if this is a Next.js 16+ project
      let nextVersion = '';
      try {
        const pkgJson = JSON.parse(readFileSync(join(clonePath, 'package.json'), 'utf8'));
        nextVersion = pkgJson.dependencies?.next ?? pkgJson.devDependencies?.next ?? '';
      } catch { /* ignore */ }

      const majorMatch = nextVersion.match(/(\d+)\./);
      const major = majorMatch ? parseInt(majorMatch[1], 10) : 0;

      if (major < 16) return null;

      log.info('Detected Next.js 16+ without proxy.ts — creating passthrough proxy');

      return {
        description: 'Add proxy.ts for Next.js 16 (middleware renamed to proxy)',
        files: [{
          path: 'proxy.ts',
          content: `import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next|api|.*\\\\..*).*)', '/'],
}
`,
        }],
      };
    },
  },
  {
    // Common: FUNCTION_INVOCATION_FAILED — often env var issues
    pattern: /FUNCTION_INVOCATION_FAILED/i,
    diagnose: async (_body: string, _clonePath: string) => {
      // This is usually an env var issue — can't fix automatically
      // but we can diagnose it
      return null;
    },
  },
];

/**
 * Diagnose a deployment URL and optionally apply fixes.
 *
 * @param deployedUrl - The URL to check
 * @param clonePath - Path to the cloned repo (for applying fixes)
 * @param autoFix - If true, commit and push fixes to the repo
 */
export async function diagnoseDeployment(
  deployedUrl: string,
  clonePath: string,
  autoFix: boolean = true
): Promise<DiagnosisResult> {
  log.info(`═══ Deployment Doctor: ${deployedUrl} ═══`);

  // Step 1: Hit the URL
  let httpStatus: number | null = null;
  let body = '';
  let errorCode: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(deployedUrl, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);

    httpStatus = resp.status;
    body = await resp.text();

    if (resp.ok) {
      log.info(`  URL is healthy (${httpStatus})`);
      return { status: 'healthy', httpStatus, errorCode: null, diagnosis: 'URL is reachable and returns 200', fixApplied: false };
    }

    // Extract error code from body
    const codeMatch = body.match(/Code:\s*`?([A-Z_]+)`?/);
    errorCode = codeMatch?.[1] ?? null;

    log.info(`  HTTP ${httpStatus} — error code: ${errorCode ?? 'unknown'}`);
  } catch (err) {
    const msg = (err as Error).message;
    log.warn(`  URL unreachable: ${msg}`);

    if (msg.includes('abort')) {
      return { status: 'unfixable', httpStatus: null, errorCode: 'TIMEOUT', diagnosis: 'Request timed out — site may not be deployed', fixApplied: false };
    }

    return { status: 'unfixable', httpStatus: null, errorCode: 'UNREACHABLE', diagnosis: `Cannot reach URL: ${msg}`, fixApplied: false };
  }

  // Step 2: Check known patterns
  for (const fix of KNOWN_FIXES) {
    if (!fix.pattern.test(body) && !fix.pattern.test(errorCode ?? '')) continue;

    log.info(`  Pattern match: ${fix.pattern.source}`);

    const action = await fix.diagnose(body, clonePath);
    if (!action) {
      log.info(`  Diagnosed but no automatic fix available`);
      continue;
    }

    log.info(`  Fix available: ${action.description}`);

    if (!autoFix) {
      return {
        status: 'fixable',
        httpStatus,
        errorCode,
        diagnosis: action.description,
        fixApplied: false,
        fixDescription: action.description,
      };
    }

    // Step 3: Apply the fix
    try {
      for (const file of action.files) {
        const filePath = join(clonePath, file.path);
        writeFileSync(filePath, file.content, 'utf8');
        log.info(`  Written: ${file.path}`);
      }

      // Commit and push
      const fileNames = action.files.map(f => f.path).join(' ');
      execSync(`git add ${fileNames}`, { cwd: clonePath, stdio: 'pipe' });
      execSync(
        `git commit -m "fix: ${action.description}\n\nAuto-fix by AppSpotlight Deployment Doctor"`,
        { cwd: clonePath, stdio: 'pipe' }
      );
      execSync('git push origin HEAD', { cwd: clonePath, stdio: 'pipe', timeout: 30000 });

      log.info(`  Fix committed and pushed!`);

      return {
        status: 'fixable',
        httpStatus,
        errorCode,
        diagnosis: action.description,
        fixApplied: true,
        fixDescription: action.description,
      };
    } catch (fixErr) {
      log.error(`  Failed to apply fix: ${(fixErr as Error).message}`);
      return {
        status: 'fixable',
        httpStatus,
        errorCode,
        diagnosis: `Fix identified but could not apply: ${(fixErr as Error).message}`,
        fixApplied: false,
        fixDescription: action.description,
      };
    }
  }

  // No known fix
  const diagnosis = errorCode
    ? `HTTP ${httpStatus} with error code ${errorCode} — no automatic fix available`
    : `HTTP ${httpStatus} — no known error pattern detected`;

  log.info(`  ${diagnosis}`);

  return { status: 'unfixable', httpStatus, errorCode, diagnosis, fixApplied: false };
}

/**
 * Wait for a Vercel deployment to complete after pushing a fix.
 * Polls the URL until it returns 200 or timeout.
 */
export async function waitForRedeploy(
  url: string,
  maxWaitMs: number = 120000,
  pollIntervalMs: number = 10000
): Promise<boolean> {
  log.info(`Waiting for redeploy of ${url} (max ${maxWaitMs / 1000}s)...`);

  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);

      if (resp.ok) {
        log.info(`  Site is back up! (${resp.status}) after ${((Date.now() - start) / 1000).toFixed(0)}s`);
        return true;
      }

      log.info(`  Still down (${resp.status}), waiting...`);
    } catch {
      log.info(`  Still unreachable, waiting...`);
    }
  }

  log.warn(`  Timeout waiting for redeploy after ${maxWaitMs / 1000}s`);
  return false;
}
