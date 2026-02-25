import express from 'express';
import { randomUUID } from 'crypto';
import {
  createLogger,
  getConfig,
  createRunRecord,
  completeRunRecord,
  failRunRecord,
  checkBudget,
} from '@appspotlight/shared';
import { analyzeRepo } from '@appspotlight/analyst';
import { publishApp } from '@appspotlight/publisher';
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
    const analystOutput = await analyzeRepo({
      repoUrl: event.cloneUrl,
    });

    // Run Publisher
    const publishResult = await publishApp(analystOutput);

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
      publishResult.qaResult
    );

    log.info(`✓ Pipeline complete: ${event.repoName} → ${publishResult.pageResult.pageUrl}`);
  } catch (err) {
    log.error(`Pipeline error: ${(err as Error).message}`);
    await failRunRecord(runId, (err as Error).message);
  }
}

// Start server
const config = getConfig();
const port = config.watcher.port;

app.listen(port, () => {
  log.info(`AppSpotlight Watcher listening on port ${port}`);
  log.info(`Webhook endpoint: POST http://localhost:${port}/webhook`);
  log.info(`Health check: GET http://localhost:${port}/health`);
});

export { app };
