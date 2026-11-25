import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'

const PANEL_HTML_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'panel', 'index.html')

test('HTML panel uses inline CSP-safe code, Orca design tokens, and session switcher controls', async () => {
  const html = await fs.readFile(PANEL_HTML_PATH, 'utf8')

  assert.ok(html.includes('<!doctype html>'))
  // CSP-safe: no external stylesheet or script network dependencies.
  assert.equal(/<script\s+[^>]*src=/i.test(html), false)
  assert.equal(/<link\s+[^>]*href=/i.test(html), false)

  // Integrates with Orca theme variables and frame bridge APIs.
  assert.ok(html.includes('--orca-foreground'))
  assert.ok(html.includes('--orca-border'))
  assert.ok(html.includes("orca.plugin.request('telemetry.selectAgent'"))
  assert.ok(html.includes("orca.plugin.request('telemetry.getSnapshot'"))
  assert.ok(html.includes("orca.plugin.on('telemetry.updated'"))
  assert.ok(html.includes("orca.on('workspace.changed'"))

  // Instant 1-click session switcher and HTML escaping helper.
  assert.ok(html.includes('data-action="select-agent"'))
  assert.ok(html.includes('data-key="__auto__"'))
  assert.ok(html.includes('function esc('))
})
