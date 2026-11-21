import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Plus, Search, Trash2 } from 'lucide-react'

type Server = { id: string; name: string; url: string; enabled: boolean; credentialConfigured: boolean; toolNames: string[] }
type Draft = { id?: string; name: string; url: string; enabled: boolean; mode: 'keep' | 'replace' | 'clear'; header: string; value: string }
const blank: Draft = { name: '', url: '', enabled: true, mode: 'keep', header: 'Authorization', value: '' }

async function check(response: Response) {
  if (response.ok) return
  const body = await response.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? `Request failed (HTTP ${response.status}). Try again.`)
}

export function ResearchMcpSettings() {
  const [servers, setServers] = useState<Server[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const editing = draft !== null
  const saved = servers.find(server => server.id === draft?.id)
  const endpointChanged = Boolean(saved && saved.url !== draft?.url.trim())
  const load = async () => {
    setLoading(true); setLoadFailed(false); setNotice(null)
    try {
      const response = await fetch('/api/research-mcp')
      await check(response)
      setServers((await response.json()).servers ?? [])
    } catch {
      setLoadFailed(true); setNotice({ text: 'Research services could not be loaded.', error: true })
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    const focus = (element: HTMLElement | null) => {
      element?.focus({ preventScroll: true })
      element?.scrollIntoView?.({ block: 'nearest' })
    }
    if (editing) {
      focus(urlInput.current)
    } else if (restoreFocus.current) {
      restoreFocus.current = false
      focus(addButton.current)
    }
  }, [editing])
  const update = (patch: Partial<Draft>) => setDraft(current => current && { ...current, ...patch })
  const close = () => { restoreFocus.current = true; setDraft(null) }
  const save = async () => {
    if (!draft || busy) return
    setBusy(true); setNotice(null)
    try {
      const url = draft.url.trim()
      const name = draft.name.trim() || new URL(url).hostname.slice(0, 100)
      const credential = draft.mode === 'replace' ? { mode: 'replace', header: draft.header.trim(), value: draft.value }
        : draft.mode === 'clear' ? { mode: 'clear' } : undefined
      const response = await fetch(draft.id ? `/api/research-mcp/${draft.id}` : '/api/research-mcp', {
        method: draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, enabled: draft.enabled, credential }),
      })
      await check(response)
      const next: Server = await response.json()
      setServers(items => draft.id ? items.map(item => item.id === next.id ? next : item) : [...items, next])
      close()
      setNotice({ text: next.enabled ? `${next.name} is ready for research.` : `${next.name} is disabled.` })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not connect. Check the URL and try again.', error: true })
    } finally { setBusy(false) }
  }
  const remove = async (server: Server) => {
    if (!window.confirm(`Remove ${server.name} and its saved credential?`)) return
    setBusy(true); setNotice(null)
    try {
      await check(await fetch(`/api/research-mcp/${server.id}`, { method: 'DELETE' }))
      setServers(items => items.filter(item => item.id !== server.id))
      addButton.current?.focus()
      setNotice({ text: `${server.name} removed.` })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not remove server.', error: true })
    } finally { setBusy(false) }
  }
  return <section className="settings-card research-section">
    <div className="section-heading"><div className="section-icon"><Search size={18}/></div><div className="section-title">
      <h2>Optional research services</h2><p>Connect an MCP server so the agent can look up context before searching Prowlarr.</p>
    </div></div>
    <div className="section-body">
      <p className="research-trust">Connecting lets the agent use this server’s tools and may share search or library context. Connect only servers you trust.</p>
      {loading ? <p role="status">Loading research services…</p> : loadFailed
        ? <button className="button button-secondary" type="button" onClick={() => void load()}>Retry loading</button> : <>
        {servers.length > 0 && <ul className="research-list">{servers.map(server => <li key={server.id} className="research-item">
          <div className="research-item-main">
            <strong>{server.name}</strong><span>{!server.enabled ? 'Disabled' : server.toolNames.length
              ? `Connected · ${server.toolNames.length} ${server.toolNames.length === 1 ? 'tool' : 'tools'} available` : 'Edit and connect to load tools'}</span>
            <code>{server.url}</code>{server.credentialConfigured && <span>Credential saved · value hidden</span>}
          </div>
          <div className="research-actions">
            <button className="button button-secondary" type="button" disabled={editing || busy} onClick={() => { setNotice(null); setDraft({ ...blank, ...server }) }}>Edit</button>
            <button className="button button-secondary" type="button" disabled={editing || busy} aria-label={`Remove ${server.name}`} onClick={() => void remove(server)}><Trash2 size={15}/></button>
          </div>
        </li>)}</ul>}
        {!editing && <button ref={addButton} className="button button-secondary" type="button" disabled={busy} onClick={() => { setNotice(null); setDraft(blank) }}><Plus size={16}/>Add a research service</button>}
        {draft && <form className="research-editor" aria-label={saved ? `Edit ${saved.name}` : 'Add a research service'} onSubmit={event => { event.preventDefault(); void save() }}>
          <label className="field">MCP URL<input ref={urlInput} type="url" autoCapitalize="none" spellCheck={false} required maxLength={2048} placeholder="http://crw:3000/mcp" value={draft.url}
            onChange={event => update({ url: event.target.value, mode: 'keep', header: 'Authorization', value: '' })}/></label>
          {saved && <label className="field">Server name<input value={draft.name} maxLength={100} onChange={event => update({ name: event.target.value })}/></label>}
          {saved && <label className="research-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })}/>Enable this research service</label>}
          <fieldset className="research-credential"><legend>Credential (optional)</legend>
            {endpointChanged ? <p className="field-hint">The old credential won’t be sent to the new URL.</p>
              : saved?.credentialConfigured && <p className="field-hint">A credential is saved and will stay hidden.</p>}
            <div className="research-credential-options">
              <label><input type="radio" name="credential-mode" checked={draft.mode === 'keep'} onChange={() => update({ mode: 'keep', value: '' })}/>{saved?.credentialConfigured && !endpointChanged ? 'Keep unchanged' : 'None'}</label>
              <label><input type="radio" name="credential-mode" checked={draft.mode === 'replace'} onChange={() => update({ mode: 'replace' })}/>{saved?.credentialConfigured ? 'Replace' : 'Add credential'}</label>
              {saved?.credentialConfigured && !endpointChanged && <label><input type="radio" name="credential-mode" checked={draft.mode === 'clear'} onChange={() => update({ mode: 'clear', value: '' })}/>Clear</label>}
            </div>
            {draft.mode === 'replace' && <div className="field-grid"><label className="field">Credential header<input required value={draft.header} onChange={event => update({ header: event.target.value })}/></label><label className="field">Credential value<input type="password" autoComplete="new-password" required value={draft.value} placeholder="Bearer TOKEN" onChange={event => update({ value: event.target.value })}/></label></div>}
          </fieldset>
          <div className="research-editor-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { close(); setNotice(null) }}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? (draft.enabled ? 'Connecting…' : 'Saving…') : draft.enabled ? 'Connect' : 'Save disabled'}</button></div>
        </form>}
      </>}
      {notice && <div className={`notice ${notice.error ? 'notice-error' : 'notice-success'} research-message`} role={notice.error ? 'alert' : 'status'}>{notice.error && <CircleAlert size={17}/>}<span>{notice.text}</span></div>}
    </div>
  </section>
}
