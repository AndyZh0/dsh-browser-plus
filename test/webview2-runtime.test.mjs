import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as remoteHost from '../lib/browser-electron/remote-host.js'

const packagePath = new URL('../package.json', import.meta.url)

test('package declares no Electron dependency', async () => {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.equal(pkg.optionalDependencies?.electron, undefined, 'the Electron runtime is gone')
  assert.equal(pkg.peerDependencies?.electron, undefined)
  assert.equal(pkg.dependencies?.electron, undefined)
})

test('the host requirement names the Windows-only WebView2 binary', () => {
  const requirement = remoteHost.hostRequirement()
  assert.equal(requirement.platform, 'win32')
  assert.equal(requirement.executable, 'dsh-browser-plus-host.exe')
})

test('the host resolver refuses a non-Windows platform with a clear message', () => {
  // The resolver is the only place that turns a platform mismatch into an
  // actionable error instead of a spawn ENOENT.
  assert.equal(typeof remoteHost.resolveHostExecutable, 'function')
  if (process.platform === 'win32') {
    // On Windows the resolver must either find the host or explain how to build
    // it; both outcomes are acceptable in a fresh checkout.
    try {
      const path = remoteHost.resolveHostExecutable()
      assert.match(path, /dsh-browser-plus-host\.exe$/)
    } catch (error) {
      assert.match(String(error), /build:host|DSH_BROWSER_PLUS_HOST/)
    }
  } else {
    assert.throws(() => remoteHost.resolveHostExecutable(), /Windows-only/)
  }
})

test('cookie export skips invalid domains and preserves valid URL forms', async () => {
  const authCookies = await import('../lib/browser-electron/auth-cookies.js').catch(() => undefined)
  assert.ok(authCookies, 'auth cookie helper module exists')
  const exported = authCookies.exportCookiesForAuth([
    { domain: undefined, path: '/', name: 'skip-missing', value: 'x', secure: true, httpOnly: true },
    { domain: '', path: '/', name: 'skip-empty', value: 'x', secure: true, httpOnly: true },
    { domain: '.example.com', path: '/', name: 'normal', value: 'x', secure: true, httpOnly: true, expirationDate: 123 },
    { domain: '::1', path: '/api', name: 'ipv6', value: 'y', secure: false, httpOnly: false },
  ])
  assert.deepEqual(exported, [
    { url: 'https://example.com/', name: 'normal', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 123 },
    { url: 'http://[::1]/api', name: 'ipv6', value: 'y', domain: '::1', path: '/api', secure: false, httpOnly: false, expirationDate: undefined },
  ])
})
