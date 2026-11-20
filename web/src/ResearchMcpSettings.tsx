import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Plus, Search, Trash2 } from 'lucide-react'

type Approval = { name: string; fingerprint: string }
type Server = { id: string; name: string; namespace: string; url: string; enabled: boolean; credentialConfigured: boolean; approvedTools: Approval[] }
type Tool = Approval & { description?: string }
type Draft = { id?: string; name: string; namespace: string; url: string; enabled: boolean; secretMode: 'unchanged' | 'replace' | 'clear'; header: string; value: string; approvedTools: Approval[] }
const blank = (url = ''): Draft => ({ name: '', namespace: '', url, enabled: true, secretMode: 'unchanged', header: 'Authorization', value: '', approvedTools: [] })

export function ResearchMcpSettings() {
  const [servers, setServers] = useState<Server[]>([])
  const [allowed, setAllowed] = useState<string[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tools, setTools] = useState<Tool[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
  const editorTitle = useRef<HTMLHeadingElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const actionOrigin = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const editing = draft !== null
  const savedDraft = servers.find(server => server.id === draft?.id)
  const endpointChanged = Boolean(savedDraft && savedDraft.url !== draft?.url)
  const refresh = async () => {
    setLoading(true); setLoadFailed(false)
    try { const response = await fetch('/api/research-mcp'); if (!response.ok) throw new Error('Research services could not be loaded.'); const data = await response.json(); setServers(data.servers ?? []); setAllowed(data.allowedEndpoints ?? []); setMessage('') }
    catch { setLoadFailed(true); setMessage('Research services could not be loaded.'); setIsError(true) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    const focus = (element: HTMLElement | null) => {
      element?.focus({ preventScroll: true })
      element?.scrollIntoView?.({ block: 'nearest' })
    }
    if (editing) focus(tools ? editorTitle.current : nameField.current)
    else if (restoreFocus.current && !busy) {
      restoreFocus.current = false
      const trigger = actionOrigin.current
      focus(trigger?.isConnected ? trigger : addButton.current)
    }
  }, [editing, tools, busy])
  const closeEditor = () => { restoreFocus.current = true; setDraft(null); setTools(null) }
  const update = (patch: Partial<Draft>) => setDraft(current => current ? { ...current, ...patch } : current)
  const fail = async (response: Response) => { let body: { error?: string } = {}; try { body = await response.json() } catch {} throw new Error(body.error ?? `Request failed (HTTP ${response.status}). Try again.`) }
  const saveServer = async () => {
    if (!draft) return
    setBusy('save'); setMessage('')
    try {
      const body: Record<string, unknown> = { name: draft.name, namespace: draft.namespace, url: draft.url, enabled: draft.enabled, approvedTools: draft.approvedTools }
      if (draft.secretMode === 'replace') body.credential = { mode: 'replace', header: draft.header, value: draft.value }
      if (draft.secretMode === 'clear') body.credential = { mode: 'clear' }
      const response = await fetch(draft.id ? `/api/research-mcp/${draft.id}` : '/api/research-mcp', { method: draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) await fail(response)
      const saved: Server = await response.json()
      setServers(items => draft.id ? items.map(item => item.id === saved.id ? saved : item) : [...items, saved])
      closeEditor()
      setMessage(tools ? 'Research tool approvals saved.' : 'Research service saved.')
      setIsError(false)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save server. Your draft is still here.'); setIsError(true) }
    finally { setBusy('') }
  }
  const discover = async (server: Server) => {
    setBusy(`discover:${server.id}`); setMessage('')
    try { const response = await fetch(`/api/research-mcp/${server.id}/discover`, { method: 'POST' }); if (!response.ok) await fail(response); const data = await response.json(); setTools(data.tools ?? []); setDraft({ ...server, secretMode: 'unchanged', header: 'Authorization', value: '' }); setMessage(data.tools?.length ? 'Review each tool and approve only those you trust.' : 'No tools were returned.'); setIsError(false) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not discover tools. Retry when the server is available.'); setIsError(true) }
    finally { setBusy('') }
  }
  const remove = async (server: Server) => {
    if (!window.confirm(`Remove ${server.name} and its saved credential and approvals?`)) return
    setBusy(`remove:${server.id}`); setMessage('')
    try { const response = await fetch(`/api/research-mcp/${server.id}`, { method: 'DELETE' }); if (!response.ok) await fail(response); setServers(items => items.filter(item => item.id !== server.id)); restoreFocus.current = true; actionOrigin.current = null; setMessage(`${server.name} removed.`); setIsError(false) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove server.'); setIsError(true) }
    finally { setBusy('') }
  }
  const beginEdit = (server: Server) => { setDraft({ ...server, secretMode: 'unchanged', header: 'Authorization', value: '' }); setTools(null) }
  return <Section title="Optional research services" description="Approved tools can gather context before Prowlarr searches. Services are optional; failures do not block a search." icon={<Search size={18}/>}>
    <p className="research-trust">Research tool calls may send request and library context to the configured server. Approval lets the tool run; it does not filter what the agent shares. Connect only services and tools you trust.</p>
    {loading ? <p role="status">Loading research services…</p> : loadFailed ? <button className="button button-secondary" type="button" onClick={() => void refresh()}>Retry loading</button> : !allowed.length && !servers.length ? <div className="research-empty"><strong>No research endpoints are allowed.</strong><p>Set <code>RESEARCH_MCP_ENDPOINTS</code> in the deployment environment and restart Media Scout to enable configuration. Use URLs without credentials.</p></div> : <>
      {servers.length ? <ul className="research-list">{servers.map(server => <li key={server.id} className="research-item"><div className="research-item-main"><strong>{server.name}</strong><span>{server.namespace} · {server.enabled ? 'Enabled' : 'Disabled'} · {server.approvedTools.length} approved {server.approvedTools.length === 1 ? 'tool' : 'tools'}</span><code>{server.url}</code>{server.credentialConfigured && <span>Credential saved · value hidden</span>}</div><div className="research-actions"><button className="button button-secondary" type="button" disabled={editing || !!busy} onClick={event => { actionOrigin.current = event.currentTarget; beginEdit(server) }}>Edit</button><button className="button button-secondary" type="button" disabled={editing || !!busy || !allowed.includes(server.url)} onClick={event => { actionOrigin.current = event.currentTarget; void discover(server) }}>{busy === `discover:${server.id}` ? 'Discovering…' : 'Discover tools'}</button><button className="button button-secondary" type="button" aria-label={`Remove ${server.name}`} disabled={editing || !!busy} onClick={() => void remove(server)}><Trash2 size={15}/></button></div></li>)}</ul> : <p className="research-empty">No research services configured. Add one to let Scout consult an external source.</p>}
      <button ref={addButton} className="button button-secondary" type="button" disabled={editing || !!busy || !allowed.length} onClick={event => { actionOrigin.current = event.currentTarget; setDraft(blank(allowed[0])); setTools(null); setMessage('') }}><Plus size={16}/>Add a research service</button>
      {allowed.length < 1 && servers.length > 0 && <p className="field-hint">No endpoints are currently allowlisted. Existing servers remain editable or removable.</p>}
      {draft && <form className="research-editor" aria-labelledby="research-editor-title" onSubmit={event => { event.preventDefault(); if (!busy) void saveServer() }}><div className="research-editor-heading"><h3 ref={editorTitle} tabIndex={-1} id="research-editor-title">{tools ? `Approve tools for ${draft.name}` : savedDraft ? `Edit ${savedDraft.name}` : 'Add a research service'}</h3><button className="text-button" type="button" disabled={!!busy} onClick={() => { closeEditor(); setMessage('') }}>Cancel</button></div>
        {!tools && <>
        <div className="field-grid"><label className="field">Server name<input ref={nameField} value={draft.name} onChange={event => update({ name: event.target.value })} required maxLength={100}/></label><label className="field">Namespace<input value={draft.namespace} onChange={event => update({ namespace: event.target.value })} required pattern={'[a-zA-Z][a-zA-Z0-9_\\-]{0,39}'}/><span className="field-hint">Unique tool prefix; letters, numbers, _ or -.</span></label>
          <label className="field span-two">Endpoint<select value={draft.url} onChange={event => update({ url: event.target.value, approvedTools: [], secretMode: 'unchanged', header: 'Authorization', value: '' })} required>{!allowed.includes(draft.url) && <option value={draft.url}>{draft.url} (not currently allowed)</option>}{allowed.map(url => <option key={url} value={url}>{url}</option>)}</select></label>
        </div>
        <label className="research-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })}/>Enable this research service</label>
        <fieldset className="research-credential"><legend>Credential</legend>{endpointChanged ? <p className="field-hint">The old endpoint’s credential will not be sent to the new one. Enter a new credential if needed.</p> : savedDraft?.credentialConfigured && <p className="field-hint">Credential saved · never shown here. Leave unchanged to keep it.</p>}
          <div className="research-credential-options"><label><input type="radio" name="credential-mode" checked={draft.secretMode === 'unchanged'} onChange={() => update({ secretMode: 'unchanged', value: '' })}/>Keep unchanged</label><label><input type="radio" name="credential-mode" checked={draft.secretMode === 'replace'} onChange={() => update({ secretMode: 'replace' })}/>Replace</label>{draft.id && <label><input type="radio" name="credential-mode" checked={draft.secretMode === 'clear'} onChange={() => update({ secretMode: 'clear', value: '' })}/>Clear</label>}</div>
          {draft.secretMode === 'replace' && <div className="field-grid"><label className="field">Credential header<input value={draft.header} onChange={event => update({ header: event.target.value })} required/></label><label className="field">Credential value<input type="password" autoComplete="new-password" value={draft.value} onChange={event => update({ value: event.target.value })} required placeholder="Bearer TOKEN or custom value"/></label></div>}
        </fieldset>
        {draft.id && <p className="field-hint">Changing the endpoint or credential clears approvals. Save connection changes first, then discover and approve tools again.</p>}
        </>}
        {tools && <fieldset className="research-tools"><legend>Choose tools the agent may call</legend>{tools.length ? tools.map(tool => <label key={tool.fingerprint} className="research-tool"><input type="checkbox" checked={draft.approvedTools.some(item => item.fingerprint === tool.fingerprint)} onChange={event => update({ approvedTools: event.target.checked ? [...draft.approvedTools.filter(item => item.name !== tool.name), { name: tool.name, fingerprint: tool.fingerprint }] : draft.approvedTools.filter(item => item.fingerprint !== tool.fingerprint) })}/><span><strong>research_{draft.namespace.toLowerCase()}_{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</span></label>) : <p>No tools available to approve.</p>}</fieldset>}
        <div className="research-editor-actions"><button className="button button-primary" type="submit" disabled={busy !== ''}>{busy === 'save' ? 'Saving…' : tools ? 'Save approvals' : 'Save server'}</button></div>
      </form>}
    </>}
    {message && <div className={`notice ${isError ? 'notice-error' : 'notice-success'} research-message`} role={isError ? 'alert' : 'status'}>{isError && <CircleAlert size={17}/>}<span>{message}</span></div>}
  </Section>
}

function Section({ title, description, icon, children }: { title: string; description: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="settings-card research-section"><div className="section-heading"><div className="section-icon">{icon}</div><div className="section-title"><h2>{title}</h2><p>{description}</p></div></div><div className="section-body">{children}</div></section> }
