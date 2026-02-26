import express from 'express';
import { randomUUID } from 'crypto';
import {
  createLogger,
  getConfig,
  createRunRecord,
  completeRunRecord,
  failRunRecord,
  checkBudget,
  updateRunRecord,
  getDraftRuns,
  getRunById,
} from '@appspotlight/shared';
import type { ReviewAction } from '@appspotlight/shared';
import { analyzeRepo, regenerateContent } from '@appspotlight/analyst';
import { publishApp, publishDraftPage } from '@appspotlight/publisher';
import { validateSignature, parseWebhookEvent, checkCooldown } from './webhook-handler.js';

const log = createLogger('watcher');

const app = express();

// Raw body for signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'appspotlight-watcher', timestamp: new Date().toISOString() });
});

// GitHub webhook endpoint
app.post('/webhook', async (req, res) => {
  const payload = req.body instanceof Buffer ? req.body.toString() : JSON.stringify(req.body);
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const eventType = req.headers['x-github-event'] as string;

  log.info(`Received webhook: ${eventType}`);

  // Validate signature
  if (!validateSignature(payload, signature)) {
    log.error('Invalid webhook signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Parse event
  const parsedPayload = JSON.parse(payload);
  const event = parseWebhookEvent(eventType, parsedPayload);

  if (!event) {
    res.status(200).json({ status: 'ignored', reason: 'Event filtered out' });
    return;
  }

  // Check cooldown
  if (!checkCooldown(event.repoName)) {
    res.status(200).json({ status: 'cooldown', repo: event.repoName });
    return;
  }

  // Respond immediately, process async
  const runId = randomUUID();
  res.status(202).json({ status: 'accepted', run_id: runId, repo: event.repoName });

  // Process pipeline asynchronously
  processPipeline(runId, event).catch(err => {
    log.error(`Pipeline failed for ${event.repoName}: ${(err as Error).message}`);
  });
});

async function processPipeline(
  runId: string,
  event: ReturnType<typeof parseWebhookEvent> & {}
): Promise<void> {
  const eventType = event.eventType === 'repository' ? 'repo_created'
    : event.eventType === 'release' ? 'release_published'
    : 'push_to_main';

  log.info(`Pipeline started: ${event.repoName} (${eventType})`);

  // Log to Supabase
  await createRunRecord(runId, event.repoName, eventType as 'repo_created' | 'push_to_main' | 'release_published');

  // Check budget
  const budgetCheck = await checkBudget();
  if (!budgetCheck.allowed) {
    log.warn(`Budget exceeded: ${budgetCheck.reason}`);
    await failRunRecord(runId, `Budget exceeded: ${budgetCheck.reason}`);
    return;
  }

  try {
    // Run Analyst
    let analystOutput = await analyzeRepo({
      repoUrl: event.cloneUrl,
    });

    // Run Publisher
    let publishResult = await publishApp(analystOutput);

    // Auto-retry if QA failed and confidence is salvageable
    if (!publishResult.qaResult.passed && analystOutput.confidence >= 40) {
      log.info(`QA failed — retrying with feedback (confidence=${analystOutput.confidence})...`);
      log.info(`Failures: ${publishResult.qaResult.failures.join('; ')}`);

      try {
        const retryOutput = await regenerateContent(
          event.cloneUrl,
          analystOutput,
          publishResult.qaResult.failures
        );

        const retryPublishResult = await publishApp(retryOutput);

        // Use retry if it's better (fewer failures or QA passes)
        if (retryPublishResult.qaResult.passed ||
            retryPublishResult.qaResult.failures.length < publishResult.qaResult.failures.length) {
          log.info(`Retry improved results (${retryPublishResult.qaResult.failures.length} failures vs ${publishResult.qaResult.failures.length})`);
          analystOutput = retryOutput;
          publishResult = retryPublishResult;
        } else {
          log.info('Retry did not improve — keeping original');
        }

        // Track retry cost and failures
        await updateRunRecord(runId, {
          retry_count: 1,
          retry_cost_usd: retryOutput.costData.total_cost_usd,
          retry_qa_failures: publishResult.qaResult.failures,
        });
      } catch (retryErr) {
        log.error(`Retry failed: ${(retryErr as Error).message} — keeping original`);
      }
    }

    // Log completion
    await completeRunRecord(
      runId,
      analystOutput.costData,
      {
        pageId: publishResult.pageResult.pageId,
        pageUrl: publishResult.pageResult.pageUrl,
        status: publishResult.pageResult.status,
      },
      analystOutput.confidence,
      publishResult.qaResult,
      analystOutput.content
    );

    log.info(`✓ Pipeline complete: ${event.repoName} → ${publishResult.pageResult.pageUrl}`);
  } catch (err) {
    log.error(`Pipeline error: ${(err as Error).message}`);
    await failRunRecord(runId, (err as Error).message);
  }
}

// ─── Review Endpoints ───────────────────────────────────────────────────────

// GET /drafts — list pending drafts
app.get('/drafts', async (_req, res) => {
  try {
    const drafts = await getDraftRuns();
    res.json(drafts);
  } catch (err) {
    log.error(`GET /drafts error: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /review/:runId — approve, edit+approve, or reject a draft
app.post('/review/:runId', async (req, res) => {
  const { runId } = req.params;
  const body = req.body as ReviewAction;

  if (!body.action || !['approve', 'edit_approve', 'reject'].includes(body.action)) {
    res.status(400).json({ error: 'Invalid action. Must be: approve, edit_approve, or reject' });
    return;
  }

  try {
    const run = await getRunById(runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    if (!run.wp_page_id) {
      res.status(400).json({ error: 'Run has no WordPress page' });
      return;
    }

    if (body.action === 'approve') {
      await publishDraftPage(run.wp_page_id);
      await updateRunRecord(runId, { publish_action: 'draft_approved' });
      log.info(`Approved and published run ${runId} (page ${run.wp_page_id})`);
      res.json({ status: 'published', pageId: run.wp_page_id });
    } else if (body.action === 'reject') {
      await updateRunRecord(runId, {
        publish_action: 'rejected',
        error_message: body.rejection_reason ?? 'Rejected by reviewer',
      });
      log.info(`Rejected run ${runId}`);
      res.json({ status: 'rejected', runId });
    } else if (body.action === 'edit_approve') {
      // For now, just approve — full edit+re-render support is Phase 4
      await publishDraftPage(run.wp_page_id);
      await updateRunRecord(runId, { publish_action: 'draft_approved' });
      log.info(`Edit-approved run ${runId} (page ${run.wp_page_id})`);
      res.json({ status: 'published', pageId: run.wp_page_id });
    }
  } catch (err) {
    log.error(`POST /review/${runId} error: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Start server
const config = getConfig();
const port = config.watcher.port;

app.listen(port, () => {
  log.info(`AppSpotlight Watcher listening on port ${port}`);
  log.info(`Webhook endpoint: POST http://localhost:${port}/webhook`);
  log.info(`Health check: GET http://localhost:${port}/health`);
});

export { app };
