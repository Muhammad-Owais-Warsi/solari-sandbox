import { useState } from 'react'
import { Terminal } from './components/Terminal'
import { Chat } from './components/Chat'
import { AgentTest } from './components/AgentTest'
import './App.css'

type IssueData = {
  title: string
  repoUrl: string
  body: string | null
  state: string
  author: string
  createdAt: string
  updatedAt: string
}

function App() {
  const [issueUrl, setIssueUrl] = useState('')
  const [issue, setIssue] = useState<IssueData | null>(null)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [loading, setLoading] = useState<'issue' | 'sandbox' | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (window.location.pathname === '/agent-test') {
    return <AgentTest />
  }

  const fetchIssue = async () => {
    if (!issueUrl.trim()) return
    setLoading('issue')
    setError(null)
    setIssue(null)
    setSandboxId(null)

    try {
      const res = await fetch('/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: issueUrl.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setIssue(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch issue')
    } finally {
      setLoading(null)
    }
  }

  const createSandbox = async () => {
    if (!issue) return
    setLoading('sandbox')
    setError(null)

    try {
      const res = await fetch('/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: issue.repoUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSandboxId(data.sandboxId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create sandbox')
    } finally {
      setLoading(null)
    }
  }

  const destroySandbox = async () => {
    if (!sandboxId) return
    await fetch(`/sandbox/${sandboxId}`, { method: 'DELETE' }).catch(() => {})
    setSandboxId(null)
  }

  return (
    <div className={`app ${sandboxId ? 'app-split' : ''}`}>
      <header>
        <h1>Solari Sandbox</h1>
        <a href="/agent-test" className="nav-link">Agent Test</a>
      </header>

      {/* Step 1: Enter issue URL */}
      {!sandboxId && (
        <>
          <div className="input-row">
            <input
              type="text"
              placeholder="https://github.com/user/repo/issues/1"
              value={issueUrl}
              onChange={(e) => setIssueUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchIssue()}
              disabled={loading !== null}
            />
            <button onClick={fetchIssue} disabled={loading !== null}>
              {loading === 'issue' ? 'Fetching...' : 'Fetch Issue'}
            </button>
          </div>

          {error && <div className="error">{error}</div>}

          {issue && (
            <div className="issue-card">
              <div className="issue-header">
                <span className={`badge badge-${issue.state}`}>{issue.state}</span>
                <h2>{issue.title}</h2>
              </div>
              <div className="issue-meta">
                <span>{issue.author}</span>
                <span className="sep">·</span>
                <span>{issue.repoUrl}</span>
              </div>
              {issue.body && (
                <pre className="issue-body">{issue.body.slice(0, 500)}{issue.body.length > 500 ? '...' : ''}</pre>
              )}
              <button onClick={createSandbox} disabled={loading === 'sandbox'} className="btn-primary">
                {loading === 'sandbox' ? 'Creating Sandbox...' : 'Create Sandbox'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Step 2: Split view — Chat + Terminal */}
      {sandboxId && (
        <div className="split-view">
          <div className="panel panel-chat">
            <div className="panel-header">
              <span>Agent</span>
              <button onClick={destroySandbox} className="btn-danger btn-sm">Destroy</button>
            </div>
            <Chat
              sandboxId={sandboxId}
              issue={issue}
            />
          </div>
          <div className="panel panel-terminal">
            <div className="panel-header">
              <span>Terminal</span>
              <span className="sandbox-id">{sandboxId.slice(0, 12)}...</span>
            </div>
            <Terminal sandboxId={sandboxId} />
          </div>
        </div>
      )}
    </div>
  )
}

export default App
