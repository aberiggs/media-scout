import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { JSDOM } from 'jsdom'
import { defaults } from './types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: dom.window.CustomEvent })
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) Object.defineProperty(globalThis, name, { configurable: true, value })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
const { cleanup, fireEvent, render, screen, within, waitFor } = await import('@testing-library/react')
const { default: App } = await import('./App')
const originalFetch = globalThis.fetch
const originalCrypto = globalThis.crypto
const env = { settings: defaults, status: { ready: false, missing: [], monitoringEnabled: false, cycleRunning: false } }
const matched = { searchId: 's1', status: 'matched', createdAt: '2026-11-15T00:00:00Z', prompt: 'Find Example', plan: { version: 2, planId: 'p1', status: 'matched', selections: [{ candidateId: 'c1', coverage: 'Season one', reason: 'Best evidence', uncertainty: 'Audio not verified' }], coverage: { covered: ['Season one'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } }, warnings: [] }, candidates: [{ candidateId: 'c1', observations: [{ title: 'Example 1080p', indexer: 'Index', seeders: 20 }] }], events: [], counts: { decisions: 2, searches: 1, candidates: 1 } }

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); sessionStorage.clear(); globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto }) })

const semanticSearch = { ...matched, searchId: 'life', plan: { version: 2, planId: 'plan-life', status: 'matched', selections: [{ candidateId: 'c1', coverage: 'Season one', reason: 'Complete release set', uncertainty: '' }], covered: ['Season one'], gaps: [], deferred: [], scopeGaps: [], extras: [], usefulOverlap: [], broadCoverage: 'complete', coverage: { covered: ['Season one'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } } }, candidates: [{ candidateId: 'c1', observations: [{ title: 'Season One Pack' }] }] }
const preparedConfirmation = { confirmationId: 'confirm-life', expiresAt: '2099-01-01T00:00:00Z', searchId: 'life', planId: 'plan-life', version: 2, client: { id: 8, name: 'qBittorrent', protocol: 'torrent', configuredCategories: [], defaultCategory: 'tv' }, dryRun: true, children: [{ candidateId: 'c1', title: 'Season One Pack', effectiveCategory: 'tv', categoryRouting: 'default', categoryNote: 'Client default category: tv', releaseCategoryIds: [5000] }] }

it('loads search and receipt without newer AbortSignal static methods', async () => {
  const any = AbortSignal.any, timeout = AbortSignal.timeout
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
  try {
    const receipt={executionId:'old-browser',searchId:'life',outcome:'running',dryRun:false,updatedAt:'2026-01-01',children:[{candidateId:'c1',outcome:'prepared'}]}
    let reads=0
    lifecycleFetch(url => {
      if(url==='/api/v2/searches/life') return Response.json({...semanticSearch,receipts:[receipt]})
      if(url==='/api/v2/executions/old-browser') { reads++; return Response.json(receipt) }
      return Response.json({})
    })
    const { SearchPage } = await import('./Search')
    render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={()=>{}} />)
    await waitFor(()=>assert.equal(reads,1))
    assert.ok(screen.getByText('Execution receipt'))
  } finally {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: any })
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: timeout })
  }
})

function lifecycleFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    return handler(url, init)
  }
}
async function selectConfirmationClient(id = '8') {
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  const select = await screen.findByLabelText('Prowlarr download client') as HTMLSelectElement
  if (select.value !== id) fireEvent.change(select, { target: { value: id } })
}
it('offers explicit confirmation for a safe failed automation receipt and reuses an expired prompt without sending', async () => {
  let detail:any={...semanticSearch,source:'automation',manualExecutionEligible:true,receipts:[{executionId:'failed',searchId:'life',outcome:'rejected',children:[{candidateId:'c1',outcome:'rejected'}]}]}
  let mutations=0
  lifecycleFetch((url,init)=>{if(init?.method==='POST')mutations++;if(url==='/api/v2/searches/life')return Response.json(detail);if(url==='/api/v2/download-clients')return Response.json({items:[{id:8,name:'Client',protocol:'torrent'}]});return Response.json({})})
  const { SearchPage } = await import('./Search')
  const view=render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={()=>{}} />)
  assert.ok(await screen.findByText('Execution receipt'))
  assert.ok(await screen.findByRole('button',{name:'Choose Prowlarr client'}))
  assert.equal(mutations,0)
  detail={...detail,manualExecutionEligible:false,manualExecutionBlockedReason:'candidate-expired',prompt:'First line\nSecond line'}
  view.rerender(<SearchPage settings={defaults} searchId="life" searchRevision={2} onSearchStarted={()=>{}} />)
  fireEvent.click(await screen.findByRole('button',{name:'Reuse saved prompt'}))
  const prompt=screen.getByLabelText('What are you looking for?') as HTMLTextAreaElement
  assert.equal(prompt.value,'First line\nSecond line')
  assert.equal(document.activeElement,prompt)
  assert.equal(mutations,0)
})
it('blocks new automation preparation for an uncertain receipt but keeps exact-key recovery available', async () => {
  const pending={confirmationId:'old-confirm',searchId:'life',planId:'plan-life',version:2,idempotencyKey:'old-key'}
  sessionStorage.setItem('media-scout-execution-pending:life',JSON.stringify(pending))
  const calls:Array<{url:string;body?:string}>=[]
  lifecycleFetch((url,init)=>{
    calls.push({url,body:init?.body?.toString()})
    if(url==='/api/v2/searches/life')return Response.json({...semanticSearch,source:'automation',manualExecutionEligible:false,manualExecutionBlockedReason:'execution-send-risk',receipts:[{executionId:'uncertain',searchId:'life',outcome:'uncertain',dryRun:false,updatedAt:'2026-01-01',children:[{candidateId:'c1',outcome:'uncertain'}]}]})
    if(url==='/api/v2/executions/commit')return Response.json({executionId:'uncertain',searchId:'life',outcome:'uncertain',dryRun:false,updatedAt:'2026-01-01',children:[{candidateId:'c1',outcome:'uncertain'}]})
    return Response.json({})
  })
  const { SearchPage }=await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={()=>{}} />)
  assert.ok(await screen.findByText(/may have been accepted/))
  assert.equal(screen.queryByRole('button',{name:'Choose Prowlarr client'}),null)
  fireEvent.click(screen.getByRole('button',{name:'Retry same confirmation'}))
  await waitFor(()=>assert.deepEqual(JSON.parse(calls.find(call=>call.url==='/api/v2/executions/commit')!.body!),pending))
})
it('keeps the receipt request alive while polling for an automation pass to finish', async () => {
  let detailReads=0, receiptReads=0, wasAborted=false, resolveReceipt!:(response:Response)=>void
  const runningReceipt={executionId:'running-exec',searchId:'life',outcome:'running',dryRun:false,updatedAt:'2026-01-01',children:[{candidateId:'c1',outcome:'prepared'}]}
  lifecycleFetch((url,init)=>{
    if(url==='/api/v2/searches/life'){detailReads++;return Response.json({...semanticSearch,source:'automation',manualExecutionEligible:false,manualExecutionBlockedReason:'automation-pass-active',automationPending:true,receipts:[runningReceipt]})}
    if(url==='/api/v2/executions/running-exec'){receiptReads++;init?.signal?.addEventListener('abort',()=>{wasAborted=true});return new Promise<Response>(resolve=>{resolveReceipt=resolve})}
    return Response.json({})
  })
  const { SearchPage }=await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={()=>{}} />)
  await waitFor(()=>assert.equal(receiptReads,1))
  await waitFor(()=>assert.ok(detailReads>=2),{timeout:3000})
  assert.equal(receiptReads,1)
  assert.equal(wasAborted,false)
  resolveReceipt(Response.json(runningReceipt))
})
it('explains queued capacity, provider cooldown and incomplete settings', async () => {
  let detail = {searchId:'waiting',status:'queued',queuePosition:2,waitingReason:'capacity',retryAt:undefined as string | undefined}
  lifecycleFetch(() => Response.json(detail))
  const { SearchPage } = await import('./Search')
  const view = render(<SearchPage settings={defaults} searchId="waiting" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/Waiting for search capacity/))
  detail = {...detail,waitingReason:'provider-cooldown',retryAt:'2099-01-01T00:00:00Z'}
  view.rerender(<SearchPage settings={defaults} searchId="waiting" searchRevision={2} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/Provider cooldown.*retry/))
  detail = {...detail,waitingReason:'settings-incomplete',retryAt:undefined}
  view.rerender(<SearchPage settings={defaults} searchId="waiting" searchRevision={3} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/Waiting for required settings/))
})
it('recovers a search status GET after a transient failure without reposting the search', async () => {
  let reads = 0, posts = 0
  lifecycleFetch((url, init) => {
    if (init?.method === 'POST') posts++
    if (url === '/api/v2/searches/life') {
      reads++
      return reads === 1 ? new Response('', {status:503}) : Response.json(semanticSearch)
    }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/temporarily unavailable/i))
  assert.ok(await screen.findByText(/Complete release set/, {}, {timeout:5000}))
  assert.equal(reads, 2)
  assert.equal(posts, 0)
})
it('treats a missing search status as terminal', async () => {
  let reads = 0
  lifecycleFetch(() => { reads++; return new Response('', {status:404}) })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="missing" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/Search not found/))
  assert.equal(screen.queryAllByRole('button', { name: 'Retry' }).length, 0)
  await new Promise(resolve => setTimeout(resolve, 3200))
  assert.equal(reads, 1)
})

it('refreshes an automation plan whose latest eligibility read sees an active execution before its receipt arrives', async () => {
  let reads = 0
  lifecycleFetch(url => {
    assert.equal(url, '/api/v2/searches/life')
    return Response.json({ ...semanticSearch, source: 'automation', ...(++reads === 1
      ? { manualExecutionEligible: false, manualExecutionBlockedReason: 'execution-active', receipts: [] }
      : { manualExecutionEligible: true, receipts: [] }) })
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/An execution is still running/))
  assert.ok(await screen.findByRole('button', { name: 'Choose Prowlarr client' }, { timeout: 3000 }))
  assert.equal(reads, 2)
})

it('reuses an over-limit automation prompt without silently truncating its request', async () => {
  const savedPrompt = `Find the requested episodes\n${'Season and episode notes. '.repeat(200)}`
  lifecycleFetch(url => {
    assert.equal(url, '/api/v2/searches/life')
    return Response.json({ ...semanticSearch, prompt: savedPrompt, source: 'automation', manualExecutionEligible: false, manualExecutionBlockedReason: 'candidate-expired' })
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => assert.fail('a search must not start')} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reuse saved prompt' }))
  assert.equal((screen.getByLabelText('What are you looking for?') as HTMLTextAreaElement).value, savedPrompt)
  assert.ok(screen.getByText(/Shorten it before starting a new search/))
  assert.ok((screen.getByRole('button', { name: 'Search releases' }) as HTMLButtonElement).disabled)
})

it('prepares and commits the complete semantic v2 release set and shows its receipt', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'v2', prompt: 'Find North Shore', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (url === '/api/v2/searches/v2') return Response.json({ ...matched, searchId: 'v2', plan: { version: 2, planId: 'plan-v2', status: 'matched', selections: [{ candidateId: 'c1', coverage: 'Season one with overlap', reason: 'Useful complete pack', uncertainty: '' }], covered: ['Season one'], gaps: [], deferred: [], scopeGaps: [], extras: ['Bonus episode'], usefulOverlap: ['Episode two'], broadCoverage: 'complete', coverage: { covered: ['Season one'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } } }, receipts: [] })
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json({ confirmationId: 'confirm-1', expiresAt: '2099-01-01T00:00:00Z', searchId: 'v2', planId: 'plan-v2', version: 2, client: { id: 8, name: 'qBittorrent', protocol: 'torrent', configuredCategories: [], defaultCategory: 'tv' }, dryRun: true, children: [{ candidateId: 'c1', title: 'North Shore complete pack', effectiveCategory: 'tv', categoryRouting: 'default', categoryNote: 'Prowlarr client default', releaseCategoryIds: [5000] }] })
    if (url === '/api/v2/executions/commit') return Response.json({ executionId: 'exec-1', searchId: 'v2', planId: 'plan-v2', version: 2, outcome: 'dry-run', updatedAt: '2026-11-15T00:00:00Z', dryRun: true, children: [{ candidateId: 'c1', outcome: 'dry-run', effectiveCategory: 'tv' }] })
    return Response.json({ items: [] })
  }
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="v2" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/Season one with overlap/))
  assert.ok(screen.getByText('Bonus episode'))
  assert.equal(screen.queryByText(/target-1/), null)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  assert.ok(await screen.findByRole('dialog', { name: 'Confirm whole release set' }))
  assert.ok(screen.getByText('Client default category').parentElement?.textContent?.includes('tv'))
  assert.ok(screen.getByText('None configured; using the client default.'))
  fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))
  assert.ok(await screen.findByText('Execution receipt'))
  assert.ok(screen.getAllByText('dry-run').length > 0)
  const prepare = calls.find(call => call.url === '/api/v2/executions/prepare')
  assert.deepEqual(JSON.parse(String(prepare?.init?.body)), { searchId: 'v2', planId: 'plan-v2', version: 2, candidateIds: ['c1'], downloadClientId: 8 })
  const commit = calls.find(call => call.url === '/api/v2/executions/commit')
  assert.ok(commit)
  assert.deepEqual(Object.keys(JSON.parse(String(commit.init?.body))).sort(), ['confirmationId', 'idempotencyKey', 'planId', 'searchId', 'version'])
})

it('submits one retained prompt draft without an early client lookup and shows the exact long saved prompt', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const longPrompt = `Find the complete season\n${'keep original audio and subtitles. '.repeat(400)}`
  lifecycleFetch((url, init) => {
    calls.push({ url, init })
    if (url === '/api/v2/searches/long') return Response.json({ ...semanticSearch, searchId: 'long', prompt: longPrompt })
    if (url === '/api/v2/searches') return Response.json({ searchId: 'long' })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  const started: string[] = []
  const view = render(<SearchPage settings={defaults} searchRevision={1} onSearchStarted={id => started.push(id)} />)
  const prompt = screen.getByLabelText('What are you looking for?') as HTMLTextAreaElement
  const draft = 'The Expanse season 2\nOriginal audio, preferably 1080p'
  fireEvent.change(prompt, { target: { value: draft } })
  fireEvent.submit(prompt.closest('form')!)
  await waitFor(() => assert.deepEqual(started, ['long']))
  view.rerender(<SearchPage settings={defaults} searchId="long" searchRevision={2} onSearchStarted={() => {}} />)
  assert.deepEqual(JSON.parse(String(calls.find(call => call.url === '/api/v2/searches')?.init?.body)), { prompt: draft })
  assert.equal(prompt.value, draft)
  assert.equal(calls.some(call => call.url === '/api/v2/download-clients'), false)
  await waitFor(() => assert.match(document.querySelector('.result-title')?.textContent ?? '', /^Find the complete season/))
  const disclosure = screen.getByText('Saved search prompt')
  fireEvent.click(disclosure)
  assert.equal(screen.getByLabelText('Exact saved search prompt').textContent, longPrompt)
  assert.ok(longPrompt.length > 12000)
})

it('requires explicit client choice when opening confirmation client selection', async () => {
  const calls: string[] = []
  lifecycleFetch(url => {
    calls.push(url)
    if (url === '/api/v2/searches/life') return Response.json({ ...semanticSearch })
    if (url === '/api/v2/searches/other') return Response.json({ ...semanticSearch, searchId: 'other', prompt: 'Other result' })
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }, { id: 9, name: 'SABnzbd', protocol: 'usenet', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  const view = render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await screen.findByText('Selected release set')
  assert.equal(calls.includes('/api/v2/download-clients'), false)
  fireEvent.click(screen.getByRole('button', { name: 'Choose Prowlarr client' }))
  const clientSelect = await screen.findByLabelText('Prowlarr download client') as HTMLSelectElement
  await waitFor(() => assert.equal(clientSelect.value, ''))
  view.rerender(<SearchPage settings={defaults} searchId="other" searchRevision={2} onSearchStarted={() => {}} />)
  await waitFor(() => assert.equal(document.querySelector('.result-title')?.textContent, 'Other result'))
  fireEvent.click(screen.getByRole('button', { name: 'Choose Prowlarr client' }))
  const nextClientSelect = await screen.findByLabelText('Prowlarr download client') as HTMLSelectElement
  await waitFor(() => assert.equal(nextClientSelect.value, '', 'A different search must not inherit the previous destination'))
})

it('connects a research MCP from a pasted URL in one request', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/research-mcp' && !init?.method) return Response.json({ servers: [] })
    if (url === '/api/research-mcp' && init?.method === 'POST') return Response.json({ id: 'srv-1', name: 'research.example', url: 'https://research.example/mcp', enabled: true, credentialConfigured: false, toolNames: ['research_mal_123_search_anime'] }, { status: 201 })
    return Response.json({})
  }
  window.location.hash = '#settings'
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Add a research service' }))
  fireEvent.change(screen.getByLabelText('MCP URL'), { target: { value: 'https://research.example/mcp' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  assert.ok(await screen.findByText('Connected · 1 tool available'))
  const writes = calls.filter(call => call.init?.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.url, '/api/research-mcp')
  assert.deepEqual(JSON.parse(String(writes[0]!.init?.body)), { name: 'research.example', url: 'https://research.example/mcp', enabled: true })
  assert.equal(screen.queryByRole('button', { name: /discover|approve/i }), null)
})

it('does not carry a typed research credential across endpoints and keeps a failed save draft', async () => {
  const writes: Array<Record<string, unknown>> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/research-mcp' && !init?.method) return Response.json({
      servers: [{ id: 'srv-1', name: 'Catalog', url: 'http://old.test/mcp', enabled: true, credentialConfigured: true, toolNames: [] }],
    })
    if (url === '/api/research-mcp/srv-1' && init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)))
      return Response.json({ error: 'MCP server is unavailable.' }, { status: 502 })
    }
    return Response.json({})
  }
  window.location.hash = '#settings'
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Replace' }))
  fireEvent.change(screen.getByLabelText('Credential value'), { target: { value: 'Bearer leave-at-old-endpoint' } })
  fireEvent.change(screen.getByLabelText('MCP URL'), { target: { value: 'http://new.test/mcp' } })
  assert.ok(!screen.queryByLabelText('Credential value'), 'Changing the endpoint must discard the typed credential')
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  assert.ok(await screen.findByText('MCP server is unavailable.'))
  assert.equal((screen.getByLabelText('MCP URL') as HTMLInputElement).value, 'http://new.test/mcp')
  assert.equal(writes.length, 1)
  assert.equal('credential' in writes[0]!, false)
})

it('retries a transport-uncertain commit with the exact persisted request and idempotency key', async () => {
  const commits: string[] = []
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    if (url === '/api/v2/executions/commit') {
      commits.push(String(init?.body))
      if (commits.length === 1) return Promise.reject(new TypeError('connection lost'))
      return Response.json({ executionId: 'exec-life', searchId: 'life', outcome: 'dry-run', dryRun: true, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'dry-run' }] })
    }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run' }))
  assert.ok(await screen.findByRole('button', { name: 'Retry same confirmation' }))
  await screen.findAllByText(/The exact confirmation and idempotency key are saved/)
  assert.equal(Boolean(screen.queryByRole('dialog')), false, 'Only same-key recovery is offered after transport uncertainty')
  const saved = JSON.parse(sessionStorage.getItem('media-scout-execution-pending:life')!)
  assert.equal(saved.confirmationId, 'confirm-life')
  fireEvent.click(screen.getByRole('button', { name: 'Retry same confirmation' }))
  assert.ok(await screen.findByText('Execution receipt'))
  assert.equal(commits.length, 2)
  assert.deepEqual(JSON.parse(commits[0]!), JSON.parse(commits[1]!))
  assert.equal(JSON.parse(commits[0]!).idempotencyKey, saved.idempotencyKey)
  assert.equal(sessionStorage.getItem('media-scout-execution-pending:life'), null)
})

it('recovers the same pending commit after a page reload without preparing a new confirmation', async () => {
  const request = { confirmationId: 'persisted-confirm', searchId: 'life', planId: 'plan-life', version: 2, idempotencyKey: 'stable-key-from-before-reload' }
  sessionStorage.setItem('media-scout-execution-pending:life', JSON.stringify(request))
  let commitBody = ''
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/executions/commit') { commitBody = String(init?.body); return Response.json({ executionId: 'exec-recovered', searchId: 'life', outcome: 'submitted', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'submitted' }] }) }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={2} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same confirmation' }))
  assert.ok(await screen.findByRole('heading', { name: 'Execution receipt' }))
  assert.deepEqual(JSON.parse(commitBody), request)
})

it('retains the exact commit recovery key when an HTTP-success response body is interrupted', async () => {
  const commits: string[] = []
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    if (url === '/api/v2/executions/commit') {
      commits.push(String(init?.body))
      if (commits.length === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('body interrupted')) } }), { status: 200 })
      return Response.json({ executionId: 'body-recovered', searchId: 'life', outcome: 'submitted', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'submitted' }] })
    }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run' }))
  await waitFor(() => assert.equal(Boolean(screen.queryByRole('dialog')), false))
  assert.ok(sessionStorage.getItem('media-scout-execution-pending:life'))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same confirmation' }))
  assert.ok(await screen.findByRole('heading', { name: 'Execution receipt' }))
  assert.equal(commits[0], commits[1])
})

it('rejects an incomplete successful preparation without opening a broken dialog', async () => {
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json({ confirmationId: 'incomplete' })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  assert.ok(await screen.findByText(/Preparation response was incomplete/))
  assert.equal(Boolean(screen.queryByRole('dialog')), false)
})

it('clears only a definitive stale-confirmation rejection and allows fresh preparation', async () => {
  let preparations = 0
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json({ ...preparedConfirmation, confirmationId: `confirm-${++preparations}` })
    if (url === '/api/v2/executions/commit') return Response.json({ code: 'confirmation-expired', message: 'Confirmation expired.' }, { status: 409 })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run' }))
  assert.ok(await screen.findByText(/Prepare a fresh confirmation/))
  assert.equal(sessionStorage.getItem('media-scout-execution-pending:life'), null)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare confirmation' }))
  assert.ok(await screen.findByRole('dialog', { name: 'Confirm whole release set' }))
  assert.equal(preparations, 2)
})

it('does not show an old confirmation after selecting another search while prepare is pending', async () => {
  let resolvePrepare!: (response: Response) => void
  let started!: () => void
  const wasStarted = new Promise<void>(resolve => { started = resolve })
  lifecycleFetch((url) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/searches/other') return Response.json({ ...semanticSearch, searchId: 'other' })
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') { started(); return new Promise<Response>(resolve => { resolvePrepare = resolve }) }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  const view = render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  await wasStarted
  view.rerender(<SearchPage settings={defaults} searchId="other" searchRevision={2} onSearchStarted={() => {}} />)
  resolvePrepare(Response.json({ ...preparedConfirmation, searchId: 'life' }))
  await waitFor(() => assert.ok(screen.getByText('Selected release set')))
  assert.ok(!screen.queryByRole('dialog'))
})

it('ignores a delayed receipt poll for the previously selected search', async () => {
  let resolvePoll!: (response: Response) => void
  let polled!: () => void
  const pollStarted = new Promise<void>(resolve => { polled = resolve })
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json({ ...semanticSearch, receipts: [{ executionId: 'old-exec', searchId: 'life', outcome: 'running', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'sending' }] }] })
    if (url === '/api/v2/searches/other') return Response.json({ ...semanticSearch, searchId: 'other', receipts: [] })
    if (url === '/api/v2/executions/old-exec') { polled(); return new Promise<Response>(resolve => { resolvePoll = resolve }) }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  const view = render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await pollStarted
  view.rerender(<SearchPage settings={defaults} searchId="other" searchRevision={2} onSearchStarted={() => {}} />)
  resolvePoll(Response.json({ executionId: 'old-exec', searchId: 'life', outcome: 'uncertain', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'uncertain', message: 'OLD SEARCH RECEIPT' }] }))
  await screen.findByText('Search plan')
  assert.equal(screen.queryByText('OLD SEARCH RECEIPT'), null)
})

it('shows child progress from a polled receipt instead of the older history snapshot', async () => {
  const initial = { executionId: 'progress', searchId: 'life', outcome: 'running', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'sending' }] }
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json({ ...semanticSearch, receipts: [initial] })
    if (url === '/api/v2/executions/progress') return Response.json({ ...initial, children: [{ candidateId: 'c1', outcome: 'submitted', message: 'Freshly recorded child progress' }] })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText('Freshly recorded child progress'))
})

it('traps confirmation focus and restores focus to the actual prepare action', async () => {
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  const prepare = await screen.findByRole('button', { name: 'Prepare confirmation' })
  fireEvent.click(prepare)
  const dialog = await screen.findByRole('dialog', { name: 'Confirm whole release set' })
  assert.equal(document.activeElement?.textContent, 'Cancel')
  const buttons = within(dialog).getAllByRole('button')
  const close = buttons.find(button => button.getAttribute('aria-label') === 'Close confirmation')!
  const confirm = buttons.find(button => button.textContent === 'Run dry-run')!
  confirm.focus()
  fireEvent.keyDown(document, { key: 'Tab' })
  assert.equal(document.activeElement, close)
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, confirm)
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.ok(!screen.queryByRole('dialog'))
  await new Promise(resolve => window.setTimeout(resolve, 5))
  assert.equal(document.activeElement, prepare)
})

it('keeps the whole-set dialog open while a commit request is pending', async () => {
  let releaseCommit!: (response: Response) => void
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    if (url === '/api/v2/executions/commit') return new Promise<Response>(resolve => { releaseCommit = resolve })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await selectConfirmationClient()
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  const confirm = await screen.findByRole('button', { name: 'Run dry-run' })
  fireEvent.click(confirm)
  await new Promise(resolve => window.setTimeout(resolve, 5))
  assert.ok(screen.getByRole('button', { name: 'Recording receipt…' }).hasAttribute('disabled'))
  const dialog = screen.getByRole('dialog')
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.mouseDown(dialog.parentElement!, { target: dialog.parentElement })
  assert.ok(screen.getByRole('dialog'))
  releaseCommit(Response.json({ executionId: 'exec-pending', searchId: 'life', outcome: 'dry-run', dryRun: true, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'dry-run' }] }))
  assert.ok(await screen.findByRole('heading', { name: 'Execution receipt' }))
})

it('starts with Search, submits a prompt without downloading, and displays selected release evidence', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: 's1', status: 'running' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json({ ...matched, prompt: 'Find North Shore', candidates: [{ candidateId: 'c1', observations: [{ title: 'North Shore 1080p', indexer: 'Example', size: 1000, seeders: 20, leechers: 2 }] }] })
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: /Search/ }))
  assert.equal(screen.queryByRole('link', { name: 'Queue' }), null)
  const nav = screen.getByRole('navigation', { name: 'Workspace' })
  for (const label of ['Search', 'Activity', 'Automation', 'Settings']) assert.ok(within(nav).getByRole('link', { name: label }))
  assert.equal(screen.getByLabelText('What are you looking for?').getAttribute('aria-label'), 'What are you looking for?')
  assert.ok(screen.getByRole('complementary', { name: 'Search information' }))
  assert.ok(screen.getAllByText(/Dry-run saved preference: on/)[0])
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find North Shore' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByText('Best evidence')
  assert.ok(screen.getAllByText(/Audio not verified/).length > 0)
  assert.deepEqual(JSON.parse(String(calls.find((call) => call.url === '/api/v2/searches' && call.init?.method === 'POST')?.init?.body)), { prompt: 'Find North Shore' })
  assert.equal(calls.some((call) => call.url === '/api/v2/submissions'), false)
})

it('labels failed searches as an operational error and shows the actionable cause', async () => {
  window.history.replaceState(null, '', '/#search')
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: 'busy-search', status: 'running' }, { status: 202 })
    if (url === '/api/v2/searches/busy-search') return Response.json({ searchId: 'busy-search', status: 'failed', prompt: 'Find Example', options: [], candidates: [], events: [{ type: 'error', data: { code: 'search-busy' } }], counts: { decisions: 0, searches: 0, candidates: 0 }, researchWarnings: ['MAL was unavailable; continuing without optional research.'], message: 'Another search is already running. Please retry after it finishes.' })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByRole('heading', { name: 'Search failed' }))
  assert.ok(screen.getAllByText(/another search is already running/i).length > 0)
  assert.ok(screen.getByText('Research service notice'))
})

it('shows a queued search and lets another request be submitted', async () => {
  window.history.replaceState(null, '', '/#search')
  let posts = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: `queued-${++posts}`, status: 'queued' }, { status: 202 })
    if (url.startsWith('/api/v2/searches/')) return Response.json({ searchId: url.split('/').at(-1), status: 'queued', prompt: 'Find Example', options: [], candidates: [], events: [], counts: { decisions: 0, searches: 0, candidates: 0 }, queuePosition: 2 })
    return Response.json({ items: [] })
  }
  render(<App />)
  const input = await screen.findByLabelText('What are you looking for?')
  fireEvent.change(input, { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByText(/queued · 1 ahead/i))
  fireEvent.change(input, { target: { value: 'Find Another' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByText(/queued · 1 ahead/i)
  assert.equal(posts, 2)
})

it('preserves an existing search when acceptance of a new search is unknown', async () => {
  let posts = 0
  let reads = 0
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(++reads === 1 ? { ...semanticSearch, status: 'running', plan: undefined } : semanticSearch)
    if (url === '/api/v2/searches' && init?.method === 'POST') { posts++; throw new TypeError('Failed to fetch') }
    throw new Error(`Unexpected request: ${url}`)
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => assert.fail('a new search was not confirmed')} />)
  await screen.findByText(/Checking indexers/)
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Another search' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  const notice = await screen.findByRole('alert')
  assert.match(notice.textContent ?? '', /could not confirm.*check Activity/i)
  assert.equal(within(notice).queryByRole('button'), null)
  assert.ok(await screen.findByRole('heading', { name: 'Search plan' }, { timeout: 3000 }))
  assert.equal(posts, 1)
})

it('opens saved search details from Activity after navigating to Search', async () => {
  window.history.replaceState(null, '', '/#activity')
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (url === '/api/v2/searches/s1') return Response.json(matched)
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('Best evidence'))
})

it('retains the single unsent prompt draft while navigating away and back', async () => {
  window.history.replaceState(null, '', '/#search')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [], total: 0 })
  render(<App />)
  const prompt = await screen.findByLabelText('What are you looking for?')
  fireEvent.change(prompt, { target: { value: 'Find a film\nOriginal audio; movie context' } })
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  assert.equal(document.querySelector('#search-workspace')?.hasAttribute('hidden'), true)
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.equal(await screen.findByLabelText('What are you looking for?'), prompt)
  assert.equal((prompt as HTMLTextAreaElement).value, 'Find a film\nOriginal audio; movie context')
  assert.equal(screen.queryByLabelText('Preferences'), null)
})

it('keeps the current result through navigation and lets Activity replace it with an older result', async () => {
  window.history.replaceState(null, '', '/#search')
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' ) return Response.json({ searchId: 'new-search' }, { status: 202 })
    if (url.startsWith('/api/v2/searches/')) {
      const id = url.split('/').at(-1)
      return Response.json({ ...matched, searchId: id, prompt: id === 'new-search' ? 'New search' : 'Old search', plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: id === 'new-search' ? 'New evidence' : 'Old evidence' }] } })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'old-search', prompt: 'Old search', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'New search' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByRole('heading', { name: 'Search plan' }))
  assert.ok(screen.getByText('New evidence'))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.ok(await screen.findByText('New evidence'))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' })); fireEvent(window, new dom.window.Event('hashchange'))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('Old evidence'))
  assert.equal(calls.filter(url => url === '/api/v2/searches').length, 1)
  assert.equal(calls.filter(url => url === '/api/v2/searches/new-search').length, 1)
})

it('continues polling a running search while its workspace is hidden', async () => {
  window.history.replaceState(null, '', '/#search')
  let reads = 0
  let posts = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' ) { posts++; return Response.json({ searchId: 'live-search' }, { status: 202 }) }
    if (url === '/api/v2/searches/live-search') {
      reads++
      return Response.json({ ...matched, searchId: 'live-search', status: reads === 1 ? 'running' : 'matched', plan: reads === 1 ? undefined : matched.plan })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [], total: 0 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByText(/Checking indexers and comparing releases/))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' })); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  await waitFor(() => assert.ok(reads >= 2), { timeout: 2500 })
  assert.equal(posts, 1)
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.ok(await screen.findByText('Best evidence'))
})

it('ignores a delayed manual-search response after a newer history selection', async () => {
  window.history.replaceState(null, '', '/#search')
  let finishPost!: (response: Response) => void
  const latePost = new Promise<Response>(resolve => { finishPost = resolve })
  const reads: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return latePost
    if (url.startsWith('/api/v2/searches/')) {
      const id = url.split('/').at(-1)!
      reads.push(id)
      return Response.json({ ...matched, searchId: id, plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: id === 'history-a' ? 'History A evidence' : 'Late manual evidence' }] } })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'history-a', prompt: 'Saved A', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Manual request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('History A evidence'))
  finishPost(Response.json({ searchId: 'late-manual' }, { status: 202 }))
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Search releases' }) as HTMLButtonElement).disabled, false))
  assert.deepEqual(reads, ['history-a'])
})

it('makes a delayed manual search discoverable after ordinary navigation', async () => {
  window.history.replaceState(null, '', '/#search')
  let finishPost!: (response: Response) => void
  const latePost = new Promise<Response>(resolve => { finishPost = resolve })
  const reads: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return latePost
    if (url === '/api/v2/searches/late-manual') {
      reads.push('late-manual')
      return Response.json({ ...matched, searchId: 'late-manual', plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: 'Late manual evidence' }] } })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [], total: 0 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Manual request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  finishPost(Response.json({ searchId: 'late-manual' }, { status: 202 }))
  await waitFor(() => assert.deepEqual(reads, ['late-manual']))
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.ok(await screen.findByText('Late manual evidence'))
})

it('reloads an explicitly reopened history result when its ID is already selected', async () => {
  window.history.replaceState(null, '', '/#activity')
  let historyReads = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'history-a', prompt: 'Saved A', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (url === '/api/v2/searches/history-a') {
      historyReads++
      return Response.json({ ...matched, searchId: 'history-a', plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: 'History A evidence' }] } })
    }
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ error: 'Manual request failed' }, { status: 503 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('History A evidence'))
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Manual request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByRole('alert')
  assert.ok(screen.queryByText('History A evidence'))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('History A evidence'))
  await waitFor(() => assert.equal(historyReads, 2))
})

it('filters Activity by media and inclusive local dates and offers every submission outcome', async () => {
  window.history.replaceState(null, '', '/#activity')
  const queries: URLSearchParams[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    queries.push(new URL(url, 'http://localhost').searchParams)
    return Response.json({ items: [], total: 0 })
  }
  render(<App />)
  await screen.findByText('No matching activity')
  assert.ok(screen.getByRole('complementary', { name: 'Activity information' }))
  fireEvent.change(screen.getByLabelText('Media'), { target: { value: 'tv' } })
  fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '2026-11-01' } })
  fireEvent.change(screen.getByLabelText('Created through'), { target: { value: '2026-11-15' } })
  await waitFor(() => {
    const query = queries.at(-1)!
    assert.equal(query.get('kind'), 'tv')
    assert.equal(query.get('createdAtFrom'), new Date('2026-11-01T00:00:00').toISOString())
    assert.equal(query.get('createdAtTo'), new Date('2026-11-15T23:59:59.999').toISOString())
    assert.equal(query.get('offset'), '0')
  })
  const statuses = within(screen.getByLabelText('Status'))
  for (const name of ['queued', 'rejected', 'partial', 'not-attempted', 'deferred']) assert.ok(statuses.queryByRole('option', { name }), `${name} is filterable`)
})

it('renders all durable receipt children without incidental event data', async () => {
  const result = { ...semanticSearch, receipts: [
    { executionId: 'exec-partial', searchId: 'life', outcome: 'partial', dryRun: false, updatedAt: '2026-11-19T12:00:00.000Z', client: { name: 'Client A', defaultCategory: 'tv' }, children: [{ candidateId: 'c1', outcome: 'submitted', categoryRouting: 'default', categoryNote: 'Client default: tv' }, { candidateId: 'c2', outcome: 'not-attempted', message: 'Stopped after prior rejection.' }] },
    { executionId: 'exec-rejected', searchId: 'life', outcome: 'rejected', dryRun: false, updatedAt: '2026-11-19T12:01:00.000Z', children: [{ candidateId: 'c1', outcome: 'rejected', categoryRouting: 'configured-mapping' }] },
  ], source: 'automation', events: [{ type: 'submission', data: { secret: 'SHOULD-NOT-RENDER' } }] }
  lifecycleFetch(url => url === '/api/v2/searches/life' ? Response.json(result) : Response.json({}))
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByRole('heading', { name: 'Durable execution receipts' }))
  assert.equal(screen.getAllByRole('heading', { name: 'Execution receipt' }).length, 2)
  assert.ok(screen.getByText('not-attempted'))
  assert.ok(screen.getByText(/Prowlarr client default/))
  assert.ok(screen.getByText(/Configured category mapping/))
  assert.equal(screen.queryByRole('heading', { name: 'Automatic submission' }), null)
  assert.equal(screen.queryByText('SHOULD-NOT-RENDER'), null)
})

it('shows an unknown count while the initial Activity request is pending', async () => {
  window.history.replaceState(null, '', '/#activity')
  let finishRequest!: (response: Response) => void
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') return Response.json(env)
    return new Promise<Response>(resolve => { finishRequest = resolve })
  }
  render(<App />)
  await screen.findByText('Loading activity…')
  const rail = screen.getByRole('complementary', { name: 'Activity information' })
  assert.ok(within(rail).getByText('—'))
  assert.ok(within(rail).getByText('Count unavailable'))
  assert.ok(screen.getByText(/— searches · Count unavailable/))
  assert.ok(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'))
  finishRequest(Response.json({ items: [], total: 0 }))
  await waitFor(() => assert.ok(within(rail).getByText('0')))
})

it('offers retry after initial Activity failure and displays the recovered count', async () => {
  window.history.replaceState(null, '', '/#activity')
  let attempts = 0
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') return Response.json(env)
    if (++attempts === 1) return Response.json({ error: 'Unavailable' }, { status: 503 })
    return Response.json({ items: [], total: 7 })
  }
  render(<App />)
  await screen.findByRole('alert')
  const rail = screen.getByRole('complementary', { name: 'Activity information' })
  assert.ok(within(rail).getByText('—'))
  assert.ok(within(rail).getByText('Count unavailable'))
  assert.ok(screen.getByText(/— searches · Count unavailable/))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => assert.ok(within(rail).getByText('7')))
  assert.ok(within(rail).getByText('recorded searches'))
  assert.equal(attempts, 2)
})

it('shows a real zero count after a successful empty Activity response', async () => {
  window.history.replaceState(null, '', '/#activity')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [], total: 0 })
  render(<App />)
  await screen.findByText('No matching activity')
  const rail = screen.getByRole('complementary', { name: 'Activity information' })
  assert.ok(within(rail).getByText('0'))
  assert.ok(within(rail).getByText('recorded searches'))
  assert.equal(within(rail).queryByText('Count unavailable'), null)
})

it('hides stale Activity rows and disables pagination when a filtered request fails', async () => {
  window.history.replaceState(null, '', '/#activity')
  let activityRequests = 0
  const queries: URLSearchParams[] = []
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') return Response.json(env)
    queries.push(new URL(String(input), 'http://localhost').searchParams)
    activityRequests++
    if (activityRequests === 1) return Response.json({ items: [{ searchId: 'old', prompt: 'Old result', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 51 })
    if (activityRequests === 2) return Response.json({ error: 'Filter request failed' }, { status: 503 })
    return Response.json({ items: [{ searchId: 'fresh', prompt: 'Filtered result', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
  }
  render(<App />)
  assert.ok(await screen.findByText('Old result'))
  assert.equal(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'), false)
  const query = screen.getByRole('textbox', { name: 'Filter searches' })
  fireEvent.change(query, { target: { value: 'new filter' } })
  await screen.findByRole('alert')
  assert.equal((query as HTMLInputElement).value, 'new filter')
  assert.equal(screen.queryByText('Old result'), null)
  assert.equal(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled'), true)
  assert.equal(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'), true)
  assert.ok(screen.getByText('Count unavailable'))
  assert.ok(screen.getByText(/— searches · Count unavailable/))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  assert.ok(await screen.findByText('Filtered result'))
  assert.equal(queries.at(-1)?.get('q'), 'new filter')
  assert.equal(queries.at(-1)?.get('offset'), '0')
})

it('renders a nested read-only plan without acquisition controls or submission requests', async () => {
  window.history.replaceState(null, '', '/#activity')
  const requests: string[] = []
  globalThis.fetch = async input => { const url = String(input); requests.push(url); if (url === '/api/settings') return Response.json(env); if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'automation', createdAt: matched.createdAt }], total: 1 }); return Response.json({ ...matched, source: 'automation', manualExecutionEligible: false }) }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('Best evidence'))
  assert.ok(screen.getAllByText('Season one').length > 0)
  assert.ok(screen.getAllByText(/Audio not verified/).length > 0)
  assert.ok(screen.getByText(/cannot be manually submitted/i))
  assert.equal(screen.queryByRole('button', { name: /^(run dry-run|confirm and submit set|prepare confirmation|choose prowlarr client)$/i }), null)
  assert.equal(requests.some(url => /submissions|download-clients/.test(url)), false)
})

for (const outcome of ['submitted', 'rate-limited'] as const) {
  it(`polls pending acquisition detail from Activity until ${outcome}`, async () => {
    window.history.replaceState(null, '', '/#activity')
    let reads = 0
    lifecycleFetch(url => {
      if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved acquisition', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
      if (url !== '/api/v2/searches/s1') throw new Error(`Unexpected request: ${url}`)
      const result = { ...matched, source: 'manual', manualExecutionEligible: false }
      if (++reads === 1) return Response.json({ ...result, acquisition: { downloadClientId: 7, status: 'pending' }, receipts: [] })
      if (outcome === 'rate-limited') return Response.json({ ...result, acquisition: { downloadClientId: 7, status: 'not-attempted', code: 'prowlarr-rate-limited' }, receipts: [] })
      return Response.json({ ...result, acquisition: { downloadClientId: 7, status: 'submitted' }, receipts: [{ executionId: 'e1', searchId: 's1', outcome: 'submitted', dryRun: false, updatedAt: matched.createdAt, children: [{ candidateId: 'c1', outcome: 'submitted' }] }] })
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
    await screen.findByText('Best evidence')
    const pending = screen.queryByText(/checking the download client for this acquisition/i)
    const terminal = outcome === 'submitted' ? /durable execution receipts/i : /Prowlarr rate-limited the download-client check/i
    assert.ok(await screen.findByText(terminal, {}, { timeout: 3000 }))
    assert.ok(pending)
    assert.equal(screen.queryByText(/checking the download client for this acquisition/i), null)
  })
}

it('keeps search available in dry-run and distinguishes a saved refresh from a live poll', async () => {
  window.history.replaceState(null, '', '/#automation')
  const calls: Array<{ url: string; method?: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method })
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/automation') return Response.json({ enabled: false, dryRun: true, running: false, providers: [], airingOffsets: [], items: [{ targetId: 'one', titleId: 'show-one', title: 'Example', kind: 'tv', seasonNumber: 1, episodeNumber: 1, status: 'missing', eligible: true }] })
    if (url === '/api/v2/automation/poll') return Response.json({ ran: false, reason: 'disabled' })
    return Response.json({ searchId: 's1' }, { status: 202 })
  }
  render(<App />)
  await screen.findByText(/Items to watch/)
  assert.ok(screen.getByRole('complementary', { name: 'Automation guidance' }))
  assert.ok(screen.getByText('Poll is explicit'))
  assert.equal(screen.queryByRole('button', { name: 'Search this item' }), null)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved view' }))
  assert.equal(calls.some(c => c.url.endsWith('/poll')), false)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Arr observations' }))
  await waitFor(() => assert.equal(calls.filter(c => c.url.endsWith('/poll')).length, 1))
})

it('groups observations by title and saves or resets Sonarr airing policy without polling', async () => {
  const { AutomationPage } = await import('./Activity')
  const calls: Array<{ url: string; method?: string; body?: string }> = []
  let fail = true, hours = 0, caughtHours = 24
  let failSave!: (response: Response) => void
  const pendingFailure = new Promise<Response>(resolve => { failSave = resolve })
  const snapshot = () => ({
    enabled: true, dryRun: true, running: false,
    providers: [{ provider: 'sonarr', known: false, unidentifiedQueueRows: 0 }, { provider: 'radarr', known: true, unidentifiedQueueRows: 0 }],
    items: [
      { targetId: 'future', titleId: 'show', title: 'Shared title', kind: 'tv', seasonNumber: 1, episodeNumber: 2, status: 'upcoming', eligible: false, metadataAirDate: '2026-12-20', eligibleAt: '2026-12-21T00:00:00.000Z' },
      { targetId: 'movie', titleId: 'movie', title: 'Shared title', kind: 'movie', status: 'waiting-for-radarr', eligible: false },
      { targetId: 'ready', titleId: 'show', title: 'Shared title', kind: 'tv', seasonNumber: 1, episodeNumber: 1, status: 'missing', eligible: true },
      { targetId: 'undated', titleId: 'undated-show', title: 'Undated', kind: 'tv', status: 'no-air-date', eligible: false },
    ],
    airingOffsets: [...(caughtHours ? [{ titleId: 'caught', title: 'Saved show', hoursEarly: caughtHours }] : []), ...(hours ? [{ titleId: 'show', title: 'Shared title', hoursEarly: hours }] : [])],
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method, body: init?.body as string | undefined })
    if (url === '/api/v2/automation') return Response.json(snapshot())
    if (url.includes('/airing-offsets/')) {
      if (fail) { fail = false; return pendingFailure }
      if (url.endsWith('/caught')) caughtHours = JSON.parse(String(init?.body)).hoursEarly
      else hours = JSON.parse(String(init?.body)).hoursEarly
      return Response.json(snapshot())
    }
    return Response.json({ items: [] })
  }
  render(<AutomationPage settings={defaults}/>)
  await screen.findByText('Items to watch')
  const groups = [...document.querySelectorAll('.automation-group')]
  assert.equal(screen.queryAllByRole('spinbutton').length, 0)
  assert.ok(screen.getByRole('button', { name: 'Options for Undated' }))
  assert.equal(groups.length, 4)
  assert.match(groups[0]!.textContent!, /Shared title/)
  assert.match(groups[0]!.textContent!, /Season 1 · Episode 1/)
  assert.equal(screen.queryByText(/Provider air date|Scout eligibility|Airing offset|Hours early/i), null)
  assert.ok(screen.getByText('Waiting for Radarr'))
  const undatedButton = screen.getByRole('button', { name: 'Options for Undated' })
  assert.equal(undatedButton.closest('.automation-group')!.querySelector('details')!.open, false)
  const movie = groups.find(group => group.querySelector('summary')?.textContent?.includes('movie')) as HTMLElement
  assert.equal(within(movie).queryByRole('button', { name: /Options/ }), null)
  fireEvent.click(undatedButton)
  let dialog = screen.getByRole('dialog', { name: 'Configure show' })
  assert.ok(within(dialog).getByText('Undated'))
  assert.ok(document.activeElement === within(dialog).getByRole('spinbutton', { name: 'Hours early' }))
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
  assert.ok(document.activeElement === within(dialog).getByRole('button', { name: 'Save' }))
  fireEvent.keyDown(dialog, { key: 'Tab' })
  assert.ok(document.activeElement === within(dialog).getByRole('spinbutton', { name: 'Hours early' }))
  fireEvent.keyDown(dialog, { key: 'Escape' })
  assert.ok(document.activeElement === undatedButton)
  fireEvent.click(undatedButton)
  dialog = screen.getByRole('dialog', { name: 'Configure show' })
  fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '10' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0)
  const showButton = screen.getByRole('button', { name: 'Options for Shared title' })
  fireEvent.click(showButton)
  dialog = screen.getByRole('dialog', { name: 'Configure show' })
  assert.ok(within(dialog).getByText(/Sonarr air date: 2026-12-20/))
  assert.ok(within(dialog).getByText(/Saved Scout eligibility:/))
  const input = within(dialog).getByRole('spinbutton', { name: 'Hours early' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  assert.ok(within(dialog).getByRole('alert'))
  fireEvent.change(input, { target: { value: '169' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0)
  fireEvent.change(input, { target: { value: '72' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  assert.ok(document.activeElement === dialog, 'dialog keeps focus while its controls are disabled')
  fireEvent.keyDown(dialog, { key: 'Escape' })
  assert.ok(screen.getByRole('dialog'))
  failSave(Response.json({ error: 'Try again later' }, { status: 503 }))
  assert.ok(await within(dialog).findByText('Try again later'))
  assert.equal(input.value, '72')
  assert.ok(document.activeElement === input, 'failure returns focus to the editable draft')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
  assert.ok(document.activeElement === showButton)
  assert.ok(screen.getByRole('status').textContent?.includes('Options saved'))
  fireEvent.click(showButton)
  dialog = screen.getByRole('dialog', { name: 'Configure show' })
  assert.equal((within(dialog).getByRole('spinbutton') as HTMLInputElement).value, '72')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to Sonarr timing' }))
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
  fireEvent.click(screen.getByRole('button', { name: 'Options for Saved show' }))
  dialog = screen.getByRole('dialog', { name: 'Configure show' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to Sonarr timing' }))
  await waitFor(() => assert.ok(!screen.queryByRole('button', { name: 'Options for Saved show' })))
  assert.ok(document.activeElement === screen.getByRole('heading', { name: 'Items to watch' }))
  assert.deepEqual(calls.filter(c => c.method === 'PUT').map(c => JSON.parse(c.body!).hoursEarly), [72, 72, 0, 0])
  assert.equal(calls.some(c => c.url.includes('/poll') || c.url.includes('/search')), false)
})

it('distinguishes a known empty actionable list from unavailable Arr observations', async () => {
  window.history.replaceState(null, '', '/#automation')
  let known = true
  let partialInventory = false
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/automation') return Response.json({ enabled: false, dryRun: true, running: false, providers: ['sonarr', 'radarr'].map(provider => ({ provider, known, observedAt: '2026-11-15T00:00:00Z', unidentifiedQueueRows: 0, ...(partialInventory && provider === 'sonarr' ? { unknownSeriesIds: ['42'] } : {}) })), items: [], airingOffsets: [] })
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'No items to watch right now' }))
  cleanup()
  partialInventory = true
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'No items to show' }))
  assert.ok(screen.getByText(/could not be fully checked/i))
  cleanup()
  partialInventory = false
  known = false
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'No items to show' }))
  assert.ok(screen.getByText(/list may be incomplete/i))
})

it('does not mark a healthy Sonarr-only watch list as incomplete', async () => {
  const { AutomationPage } = await import('./Activity')
  globalThis.fetch = async input => String(input) === '/api/v2/automation'
    ? Response.json({ enabled: false, dryRun: true, running: false, airingOffsets: [],
      providers: [
        { provider: 'sonarr', known: true, observedAt: new Date().toISOString(), unidentifiedQueueRows: 0 },
        { provider: 'radarr', known: false, error: 'not-configured', unidentifiedQueueRows: 0 },
      ],
      items: [{ targetId: 'episode-one', titleId: 'show-one', title: 'Example', kind: 'tv', seasonNumber: 1, episodeNumber: 1, status: 'missing', eligible: true }],
    })
    : Response.json({ items: [] })
  render(<AutomationPage settings={defaults}/>)
  assert.ok(await screen.findByText('Season 1 · Episode 1'))
  assert.ok(!screen.queryByText(/list may be incomplete/i), 'unconfigured Radarr should not imply missing observations')
})

it('keeps Settings sections scannable and distinguishes required from optional services', async () => {
  window.history.replaceState(null, '', '/#settings')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [] })
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'Search services' }))
  assert.ok(screen.getByRole('complementary', { name: 'Instance information' }))
  assert.equal(screen.getAllByText('Optional').length, 2)
  assert.ok(screen.getByRole('button', { name: 'Reveal Prowlarr API key' }))
  assert.ok(screen.getByRole('spinbutton', { name: /Search-only retry \(minutes\)/ }))
})

it('places automation defaults and client choices in Automation and saves download permission only on explicit save', async () => {
  window.history.replaceState(null, '', '/#settings')
  const saved: any[] = []
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && init?.method === 'PUT') {
      const settings = JSON.parse(String(init.body)); saved.push(settings)
      return Response.json({ settings, status: env.status })
    }
    if (String(input) === '/api/settings') return Response.json({ ...env, settings: { ...defaults, integrations: { ...defaults.integrations, prowlarr: { ...defaults.integrations.prowlarr, tvClientId: 99 } } } })
    if (String(input) === '/api/v2/download-clients') return Response.json({ items: [{ id: 7, name: 'qBittorrent', protocol: 'torrent' }, { id: 12, name: '7', protocol: 'torrent' }] })
    return Response.json({ items: [] })
  }
  render(<App />)
  await screen.findByRole('heading', { name: 'Search services' })
  const permission = await screen.findByRole('switch', { name: 'Allow automatic downloads' })
  assert.equal(screen.getByRole('textbox', { name: 'Automation media preferences' }).closest('section')?.querySelector('h2')?.textContent, 'Automation and retries')
  assert.equal(permission.getAttribute('aria-checked'), 'false')
  assert.ok(screen.getByRole('textbox', { name: 'Automation media preferences' }))
  const tvClient = screen.getByRole('combobox', { name: /TV download client/ })
  assert.ok(tvClient.textContent?.includes('Saved client #99'))
  fireEvent.change(tvClient, { target: { value: '12' } })
  fireEvent.click(permission)
  assert.equal(saved.length, 0)
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => assert.equal(saved.at(-1)?.monitoring.allowDownloads, true))
  assert.equal(saved.at(-1)?.monitoring.enabled, false)
  assert.equal(saved.at(-1)?.integrations.prowlarr.tvClientId, 12)
})

it('shows gated automation state and links to recent automation receipts without enabling execution controls', async () => {
  window.history.replaceState(null, '', '/#automation')
  let activityUrl = ''
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json({ ...env, settings: defaults })
    if (url === '/api/v2/automation') return Response.json({ enabled: true, allowDownloads: false, dryRun: true, running: false, executionBlocked: true, executionBlockedReason: 'downloads-not-activated', providers: [], items: [] })
    if (url.startsWith('/api/v2/activity')) { activityUrl = url; return Response.json({ items: [{ searchId: 'auto-1', prompt: 'Automated search', status: 'matched', source: 'automation', createdAt: matched.createdAt }], total: 1 }) }
    if (url === '/api/v2/searches/auto-1') return Response.json({ ...semanticSearch, searchId: 'auto-1', source: 'automation', manualExecutionEligible: false })
    return Response.json({})
  }
  render(<App />)
  assert.ok(await screen.findByText(/Monitoring: on/))
  assert.ok(screen.getAllByText(/automatic downloads are not allowed/i).length)
  fireEvent.click(screen.getByRole('button', { name: 'View search details' }))
  await screen.findByText('Search plan')
  assert.match(activityUrl, /source=automation/)
  assert.equal(screen.queryByRole('button', { name: /prepare confirmation|search this item|confirm and submit/i }), null)
})

it('shows server validation details as an error and preserves the rejected form values', async () => {
  window.history.replaceState(null, '', '/#settings')
  let submitted: Record<string, any> | undefined
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && !init?.method) return Response.json(env)
    if (String(input) === '/api/settings' && init?.method === 'PUT') {
      submitted = JSON.parse(String(init.body))
      return Response.json({ error: 'Invalid settings', issues: [{ path: ['monitoring', 'failureBackoffMaxMinutes'], message: 'must be at least failureBackoffMinMinutes', code: 'custom' }] }, { status: 400 })
    }
    return Response.json({ items: [] })
  }
  render(<App />)
  const minimum = await screen.findByRole('spinbutton', { name: /Initial failure backoff \(minutes\)/ })
  const maximum = screen.getByRole('spinbutton', { name: /Maximum failure backoff \(minutes\)/ })
  fireEvent.change(minimum, { target: { value: '90' } })
  fireEvent.change(maximum, { target: { value: '30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  const error = await screen.findByRole('alert')
  assert.match(error.textContent ?? '', /Maximum failure backoff.*must be at least Initial failure backoff/i)
  assert.equal((maximum as HTMLInputElement).value, '30')
  assert.equal(submitted?.monitoring.failureBackoffMaxMinutes, 30)
})

it('uses committed safety settings across navigation while preserving drafts and failed saves', async () => {
  window.history.replaceState(null, '', '/#settings')
  const committed = structuredClone(defaults)
  committed.safety.dryRun = false
  let putFails = true
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && init?.method === 'PUT') {
      if (putFails) return Response.json({ error: 'no' }, { status: 500 })
      const value = JSON.parse(String(init.body))
      return Response.json({ ...env, settings: value })
    }
    if (String(input) === '/api/settings') return Response.json({ ...env, settings: committed })
    if (String(input).startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (String(input).startsWith('/api/v2/searches/')) return Response.json(matched)
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Dry-run mode' }))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' }))
  assert.ok(await screen.findByText(/unsaved settings/i))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  await screen.findByRole('heading', { name: 'Selected release set' })
  assert.ok(screen.getAllByText(/Dry-run saved preference: off/)[0])
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
  assert.equal((await screen.findByRole('switch', { name: 'Dry-run mode' })).getAttribute('aria-checked'), 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByRole('alert')
  assert.ok(screen.getByText(/unsaved settings/i))
  fireEvent.click(screen.getByRole('link', { name: 'Search' }))
  assert.ok(await screen.findByText('Saved dry-run preference: off'))
})

it('blocks operational search when committed settings cannot be loaded and allows retry', async () => {
  let attempts = 0
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') {
      if (++attempts === 1) return Response.json({ error: 'offline' }, { status: 503 })
      return Response.json(env)
    }
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByText(/could not load settings/i))
  assert.equal(screen.queryByRole('button', { name: 'Search releases' }), null)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  assert.ok(await screen.findByRole('button', { name: 'Search releases' }))
  assert.equal(attempts, 2)
})

it('uses committed dry-run after a draft turns it off, and save success commits the draft', async () => {
  window.history.replaceState(null, '', '/#settings')
  const committed = structuredClone(defaults)
  committed.safety.dryRun = true
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && init?.method === 'PUT') return Response.json({ ...env, settings: JSON.parse(String(init.body)) })
    if (String(input) === '/api/settings') return Response.json({ ...env, settings: committed })
    if (String(input).startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (String(input).startsWith('/api/v2/searches/')) return Response.json(matched)
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Dry-run mode' }))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' }))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  await screen.findByRole('heading', { name: 'Selected release set' })
  assert.ok(screen.getByText('Saved dry-run preference: on'))
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
  await screen.findByText('Settings saved.')
  fireEvent.click(screen.getByRole('link', { name: 'Search' }))
  assert.ok(await screen.findByText('Saved dry-run preference: off'))
})

it('keeps a cleared numeric field blank instead of silently turning it into zero', async () => {
  window.history.replaceState(null, '', '/#settings')
  const writes: string[] = []
  globalThis.fetch = async (input, init) => { writes.push(`${String(input)}:${init?.method ?? 'GET'}`); return String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [] }) }
  render(<App />)
  const limit = await screen.findByRole('spinbutton', { name: /Indexer searches/ }) as HTMLInputElement
  fireEvent.change(limit, { target: { value: '' } })
  assert.equal(limit.value, '')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  assert.equal(writes.includes('/api/settings:PUT'), false)
})

it('provides working reveal and copy controls for API keys', async () => {
  window.history.replaceState(null, '', '/#settings')
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  const configured = structuredClone(defaults)
  configured.integrations.prowlarr.apiKey = 'prowlarr-test-key'
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json({ ...env, settings: configured }) : Response.json({ items: [] })
  render(<App />)
  const key = await screen.findByLabelText('Prowlarr API key') as HTMLInputElement
  assert.equal(key.type, 'password')
  fireEvent.click(screen.getByRole('button', { name: 'Reveal Prowlarr API key' }))
  assert.equal(key.type, 'text')
  fireEvent.click(screen.getByRole('button', { name: 'Copy Prowlarr API key' }))
  await waitFor(() => assert.equal(copied, 'prowlarr-test-key'))
})

it('explains when secure clipboard access is unavailable instead of silently ignoring copy', async () => {
  window.history.replaceState(null, '', '/#settings')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('insecure context') } } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  const configured = structuredClone(defaults)
  configured.integrations.prowlarr.apiKey = 'prowlarr-test-key'
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json({ ...env, settings: configured }) : Response.json({ items: [] })
  render(<App />)
  await screen.findByLabelText('Prowlarr API key')
  fireEvent.click(screen.getByRole('button', { name: 'Copy Prowlarr API key' }))
  assert.ok(await screen.findByText('Clipboard is unavailable. Reveal the key and copy it manually.'))
})
