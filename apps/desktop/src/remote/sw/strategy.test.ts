// FIX29 WP6c §5: `strategyFor` classifies every URL class the worker meets, and
// nothing under `/api/` is ever cacheable.

import { describe, expect, it } from 'vitest'
import { strategyFor, type RemoteFetchStrategy } from './strategy'

describe('remote service worker strategyFor', () => {
  it('never caches anything under /api/ and does not intercept a non-GET', () => {
    expect(strategyFor('/api/rpc', 'POST')).toBe('bypass')
    expect(strategyFor('/api/pair', 'POST')).toBe('bypass')
    expect(strategyFor('/api/logout', 'POST')).toBe('bypass')
    expect(strategyFor('/api/me', 'GET')).toBe('network-only')
    expect(strategyFor('/api/events', 'GET')).toBe('network-only')
    expect(strategyFor('/api/pair', 'GET')).toBe('network-only')
  })

  it('accepts an absolute URL as well as a path', () => {
    expect(strategyFor('https://work-pc.example-tailnet.ts.net/api/rpc', 'POST')).toBe('bypass')
    expect(strategyFor('https://work-pc.example-tailnet.ts.net/api/me', 'GET')).toBe('network-only')
    expect(strategyFor('https://work-pc.example-tailnet.ts.net/remote.html', 'GET')).toBe('network-first')
  })

  it('is case-insensitive about the method', () => {
    expect(strategyFor('/api/rpc', 'post')).toBe('bypass')
    expect(strategyFor('/api/me', 'get')).toBe('network-only')
  })

  it('serves the shell network-first', () => {
    expect(strategyFor('/', 'GET')).toBe('network-first')
    expect(strategyFor('/remote.html', 'GET')).toBe('network-first')
  })

  it('serves hashed assets from the cache first', () => {
    expect(strategyFor('/assets/remote-DXB5vYc3.js', 'GET')).toBe('cache-first')
    expect(strategyFor('/assets/bitbots-DL6Ujsob.css', 'GET')).toBe('cache-first')
    expect(strategyFor('/assets/index-Bzv5PnAn.png', 'GET')).toBe('cache-first')
  })

  it('passes everything else to the network', () => {
    expect(strategyFor('/remote.webmanifest', 'GET')).toBe('network')
    expect(strategyFor('/icons/icon-192.png', 'GET')).toBe('network')
    expect(strategyFor('/health', 'GET')).toBe('network')
    expect(strategyFor('/something-NOTAHASH', 'GET')).toBe('network')
  })

  it('exposes no cache strategy for /api/', () => {
    const cacheUsing: RemoteFetchStrategy[] = ['cache-first', 'network-first']
    for (const url of ['/api/me', '/api/pair', '/api/rpc', '/api/events', '/api/logout', '/api/anything']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect(cacheUsing).not.toContain(strategyFor(url, method))
      }
    }
  })
})
