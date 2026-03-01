#!/usr/bin/env tsx

/**
 * Apply mobile menu CSS fix to WordPress site
 * Reads mobile-menu-fix.css and appends it to WordPress custom CSS
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appendCustomCSS } from '../packages/publisher/src/index.js';
import { createLogger } from '../packages/shared/dist/index.js';

const log = createLogger('apply-menu-fix');
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    log.info('═══ Applying Mobile Menu Fix ═══');
    
    // Read CSS file
    const cssPath = join(__dirname, '..', 'mobile-menu-fix.css');
    const css = readFileSync(cssPath, 'utf-8');
    
    log.info(`Read ${css.length} bytes from mobile-menu-fix.css`);
    
    // Append to WordPress custom CSS
    log.info('Appending to WordPress custom CSS...');
    await appendCustomCSS(css);
    
    log.info('✓ Mobile menu fix applied successfully!');
    log.info('Visit https://zivraviv.com on mobile to verify the fix.');
    
  } catch (error) {
    log.error(`Failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
