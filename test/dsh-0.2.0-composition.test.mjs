/**
 * DSH 0.2.0 composition compatibility.
 *
 * The plugin targets the DeepSeek Harness 0.2.0 runtime line
 * (`@deepseek-ai/dsh-tools` 0.2.0-rc.2, `@deepseek-ai/cordis` 4.0.4,
 * `@deepseek-ai/dsh-llm` 0.2.0-rc.2). Every other test in this suite fakes the
 * `ctx` surface, so a framework API change would only surface in production.
 * This test loads the real cordis runtime and the real 0.2.0 services, mounts
 * the plugin's three layers exactly as `cordis.patch.yml` does, and asserts the
 * model-facing surface the framework sees.
 *
 * It is the regression net for the 0.1.x -> 0.2.0 migration: if a future
 * framework release drops a service, renames a registration method, or changes
 * the tool schema contract, this fails before the plugin ships.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

import { BrowserRuntime } from '../lib/browser/runtime.js'
import { apply as applyTools } from '../lib/tool-browser/index.js'

/** The model-facing tools the plugin promises; order follows registration. */
const BROWSER_TOOLS = [
  'browser_open',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_stop',
  'browser_space',
  'browser_tasks',
  'browser_handoff',
  'browser_snapshot',
  'browser_click_ref',
  'browser_scroll_into_view',
  'browser_challenge',
  'browser_execute',
  'browser_content',
  'browser_click',
  'browser_double_click',
  'browser_hover',
  'browser_scroll',
  'browser_upload_file',
  'browser_wait_for',
  'browser_type',
  'browser_press_key',
  'browser_fill',
  'browser_screenshot',
  'browser_list_tabs',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_reset',
  'browser_history',
  'browser_replay',
  'browser_download',
  'browser_session',
  'browser_reset_session',
  'browser_restrict',
  'browser_auth',
]

/** A provider good enough for the tool layer to resolve one usable backend. */
function fakeProvider() {
  return {
    id: 'composition-probe',
    available: () => true,
    open: async () => 'composition-session',
    openUrl: async () => {},
    snapshot: async () => ({ url: 'about:blank', elements: [] }),
    click: async () => {},
    type: async () => {},
    close: async () => {},
  }
}

/** Mount the runtime services the plugin's `inject` lists declare. */
async function mountRuntime() {
  const ctx = new Context()
  ctx.plugin(BrowserRuntime)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SystemPrompt)
  await new Promise(resolve => setTimeout(resolve, 0))
  return ctx
}

test('DSH 0.2.0 runtime resolves every service the plugin injects', async () => {
  const ctx = await mountRuntime()
  const browser = ctx.get('browser')
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')

  assert.ok(browser instanceof BrowserRuntime, 'ctx.browser resolves to the seam service')
  assert.ok(tools !== undefined, 'ctx.tools resolves to the 0.2.0 ToolRuntime')
  assert.ok(systemPrompt !== undefined, 'ctx.systemPrompt resolves to the 0.2.0 registry')

  // The seam surface the tool layer drives, unchanged across the migration.
  for (const method of ['open', 'openUrl', 'snapshot', 'click', 'type', 'close', 'registerBrowserProvider']) {
    assert.equal(typeof browser[method], 'function', 'ctx.browser.' + method + ' is callable')
  }
  assert.equal(typeof tools.register, 'function', 'ctx.tools.register is callable')
  assert.equal(typeof tools.schemas, 'function', 'ctx.tools.schemas is callable')
  assert.equal(typeof systemPrompt.section, 'function', 'ctx.systemPrompt.section is callable')
})

test('the tool layer registers all browser_* tools with the 0.2.0 registry', async () => {
  const ctx = await mountRuntime()
  ctx.get('browser').registerBrowserProvider(fakeProvider())

  applyTools(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  const schemas = ctx.get('tools').schemas()
  const browserNames = schemas.map(schema => schema.name).filter(name => name.startsWith('browser_'))
  assert.deepEqual(browserNames, BROWSER_TOOLS, 'every browser tool is registered exactly once, in order')

  for (const schema of schemas) {
    if (!schema.name.startsWith('browser_')) continue
    assert.equal(typeof schema.description, 'string', schema.name + ' carries a model-facing description')
    assert.ok(schema.description.length > 0, schema.name + ' description is non-empty')
    assert.ok(schema.parameters !== undefined, schema.name + ' carries a parameter schema')
  }
})

test('browser tool schemas survive 0.2.0 JSON-schema projection', async () => {
  const ctx = await mountRuntime()
  ctx.get('browser').registerBrowserProvider(fakeProvider())
  applyTools(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  const schemas = ctx.get('tools').schemas()
  const open = schemas.find(schema => schema.name === 'browser_open')
  assert.ok(open !== undefined, 'browser_open is registered')
  // The registry projects the author schema into the model-facing JSON Schema;
  // a shape change here means the 0.2.0 schema contract moved.
  assert.equal(open.parameters.type, 'object')
  assert.ok(open.parameters.properties.url !== undefined, 'browser_open.url is model-visible')
  assert.ok(open.parameters.properties.url.description.length > 0, 'parameter descriptions survive projection')
})

test('the tool layer registers its system-prompt section with the 0.2.0 registry', async () => {
  const ctx = await mountRuntime()
  ctx.get('browser').registerBrowserProvider(fakeProvider())
  applyTools(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  const assembly = await ctx.get('systemPrompt').assemble()
  const section = assembly.sections.find(entry => entry.name === 'tool:browser')
  assert.ok(section !== undefined, 'the tool guidance section is registered')
  assert.match(section.text, /browser_snapshot/, 'the guidance still teaches the snapshot-first workflow')
})
