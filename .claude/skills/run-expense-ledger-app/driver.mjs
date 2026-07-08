#!/usr/bin/env node
// Minimal chromium-cli-style REPL for driving the Household Ledger web app
// headlessly. Reads commands from stdin (one per line), one browser tab per
// process. Built because `chromium-cli` isn't installed in this container —
// see SKILL.md for why and for the fallback rationale.
//
// Commands:
//   nav <url>                    go to url (relative URLs need a prior absolute nav)
//   wait-for text=<text>         wait for an element containing text
//   wait-for <selector>          wait for a CSS selector
//   click <selector>             click an element
//   fill <selector> <value...>   set an input's value (fires input/change events)
//   press <key>                  keyboard.press (e.g. Enter, Escape)
//   eval <js-expression>         page.evaluate(expr), prints JSON result
//   screenshot [name]            full-page PNG -> SHOTS_DIR, prints the path
//   console                      dump all captured console/page-error messages
//   console --errors             dump only console.error + uncaught page errors
//   sleep <ms>                   pause (avoid unless polling isn't possible)
//   help                         list commands
//   quit | exit                  close the browser and exit
//
// Usage:
//   node driver.mjs <<'EOF'
//   nav http://localhost:8930/index.html
//   wait-for text=Household Ledger
//   screenshot home
//   console --errors
//   quit
//   EOF

import { createRequire } from 'module';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) {}
  // Fall back to this container's global install (no local node_modules here).
  const candidates = [
    '/opt/node22/lib/node_modules/playwright',
    process.env.PLAYWRIGHT_GLOBAL_PATH,
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch (e) {}
  }
  throw new Error('Could not load "playwright". Try: npm install -g playwright, or set PLAYWRIGHT_GLOBAL_PATH.');
}

const SHOTS_DIR = process.env.SHOTS_DIR || '/tmp/expense-ledger-shots';
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const { chromium } = await loadPlaywright();

const execCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
].filter(Boolean);
const executablePath = execCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

const browser = await chromium.launch({
  executablePath, // undefined -> Playwright's own default resolution
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });

const consoleLog = [];
page.on('console', msg => consoleLog.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', err => consoleLog.push({ type: 'pageerror', text: String(err) }));

function log(...a) { console.log(...a); }

async function runLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return true;
  const sp = line.indexOf(' ');
  const cmd = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1).trim();

  try {
    switch (cmd) {
      case 'nav': {
        await page.goto(rest, { waitUntil: 'load', timeout: 30000 });
        log('OK nav', page.url());
        break;
      }
      case 'wait-for': {
        if (rest.startsWith('text=')) {
          await page.getByText(rest.slice(5), { exact: false }).first().waitFor({ timeout: 15000 });
        } else {
          await page.waitForSelector(rest, { timeout: 15000 });
        }
        log('OK wait-for', rest);
        break;
      }
      case 'click': {
        await page.click(rest, { timeout: 15000 });
        log('OK click', rest);
        break;
      }
      case 'fill': {
        const sp2 = rest.indexOf(' ');
        const sel = sp2 === -1 ? rest : rest.slice(0, sp2);
        const val = sp2 === -1 ? '' : rest.slice(sp2 + 1);
        await page.fill(sel, val, { timeout: 15000 });
        log('OK fill', sel);
        break;
      }
      case 'press': {
        await page.keyboard.press(rest);
        log('OK press', rest);
        break;
      }
      case 'eval': {
        const result = await page.evaluate(new Function('return (' + rest + ')'));
        log('OK eval', JSON.stringify(result));
        break;
      }
      case 'screenshot': {
        const name = (rest || ('shot-' + Date.now())).replace(/[^a-z0-9_-]/gi, '_');
        const file = path.join(SHOTS_DIR, name + '.png');
        await page.screenshot({ path: file, fullPage: true });
        log('OK screenshot', file);
        break;
      }
      case 'console': {
        const onlyErrors = rest.trim() === '--errors';
        const rows = onlyErrors
          ? consoleLog.filter(m => m.type === 'error' || m.type === 'pageerror')
          : consoleLog;
        if (!rows.length) log('OK console (none)');
        else rows.forEach(m => log(`[${m.type}] ${m.text}`));
        break;
      }
      case 'sleep': {
        await new Promise(r => setTimeout(r, Number(rest) || 0));
        log('OK sleep', rest);
        break;
      }
      case 'help': {
        log(`commands: nav <url> | wait-for text=<t>|<selector> | click <selector> | fill <selector> <value> | press <key> | eval <js> | screenshot [name] | console [--errors] | sleep <ms> | quit`);
        break;
      }
      case 'quit':
      case 'exit': {
        await browser.close();
        return false;
      }
      default:
        log('ERR unknown command:', cmd);
    }
  } catch (e) {
    log('ERR', cmd, (e && e.message || String(e)).split('\n')[0]);
  }
  return true;
}

// `for await` pulls one line at a time from the async iterator, only
// advancing once the previous command's promise resolves — unlike the
// 'line' event (which fires for every buffered line as soon as a piped
// heredoc arrives, racing ahead of an async handler regardless of
// rl.pause()/resume()). That race silently ran every command concurrently
// against a single page/browser that later commands then found closed.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let closed = false;
for await (const line of rl) {
  const keepGoing = await runLine(line);
  if (!keepGoing) { closed = true; break; }
}
if (!closed) { try { await browser.close(); } catch (e) {} }
process.exit(0);
