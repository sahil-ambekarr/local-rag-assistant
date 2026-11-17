// Captures README screenshots from the running app.
// 1. Start the server (npm run dev) with the sample docs ingested.
// 2. npm run screenshots [-- "question"]
// Uses the locally installed Chrome through playwright-core.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const baseUrl = process.env.APP_URL ?? 'http://localhost:4101';
const question = process.argv[2] ?? 'How many vacation days do I get, and how many can I carry over?';
const outDir = path.resolve(import.meta.dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await page.goto(baseUrl);
  await page.waitForSelector('#doc-list li .name');
  await page.waitForFunction(() => (document.getElementById('model') as HTMLSelectElement).options.length > 0);

  await page.fill('#question', question);
  await page.click('#ask-button');
  // CPU-only generation is slow; allow up to ten minutes.
  await page.waitForSelector('#answer .cite', { timeout: 600_000 });
  await page.waitForFunction(() => !document.getElementById('answer')!.classList.contains('streaming'), undefined, {
    timeout: 600_000,
  });
  const failed = await page.locator('#timing.error').count();
  if (failed) throw new Error(`The app reported an error: ${await page.textContent('#timing')}`);

  await page.screenshot({ path: path.join(outDir, 'answer-with-citations.png'), fullPage: true });

  // Click the first citation to show the expanded source passage.
  await page.click('#answer .cite');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'citation-expanded.png'), fullPage: true });
  process.stdout.write(`Saved screenshots to ${outDir}\n`);
} finally {
  await browser.close();
}
