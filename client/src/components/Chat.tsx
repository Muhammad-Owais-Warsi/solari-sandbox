import { useState, useRef, useEffect } from 'react'

type FileChange = { path: string; content: string }

type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'thinking' }
  | { role: 'analysis'; content: string; _streaming?: boolean }
  | { role: 'tool'; name: string; args: Record<string, any>; result?: string }
  | { role: 'files'; changes: FileChange[] }
  | { role: 'status'; content: string }
  | { role: 'error'; content: string }
  | { role: 'done'; filesChanged: number; answer?: string }

interface ChatProps {
  sandboxId: string
  issue: { title: string; body: string | null; author: string; repoUrl: string } | null
}

const filePathShort = (p: string) => p.replace('/work/repo/', '').replace(/^\/work\/repo/, '...')

const formatToolName = (name: string) =>
  name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export function Chat({ sandboxId, issue }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const analysisRef = useRef('')

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const finalizeAnalysis = () => {
    if (!analysisRef.current) return
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'analysis' && last._streaming) {
        return [...prev.slice(0, -1), { role: 'analysis' as const, content: analysisRef.current }]
      }
      return prev
    })
    analysisRef.current = ''
  }

  const applyEvent = (event: any) => {
    if (event.type === 'thinking') {
      finalizeAnalysis()
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last?.role === 'thinking') return prev
        return [...prev, { role: 'thinking' }]
      })
    } else if (event.type === 'analysis') {
      analysisRef.current += event.content
      const text = analysisRef.current
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'analysis' && last._streaming) {
          return [...prev.slice(0, -1), { role: 'analysis', content: text, _streaming: true }]
        }
        return [...prev, { role: 'analysis', content: text, _streaming: true }]
      })
    } else if (event.type === 'tool_call') {
      finalizeAnalysis()
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'tool' && !last.result) {
          return [...prev.slice(0, -1), { role: 'tool', name: event.name, args: event.args || {} }]
        }
        return [...prev, { role: 'tool', name: event.name, args: event.args || {} }]
      })
    } else if (event.type === 'tool_result') {
      finalizeAnalysis()
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'tool' && last.name === event.name) {
          return [...prev.slice(0, -1), { role: 'tool', name: last.name, args: last.args, result: event.result }]
        }
        return [...prev, { role: 'tool', name: event.name, args: {}, result: event.result }]
      })
    } else if (event.type === 'file_change') {
      finalizeAnalysis()
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'files') {
          return [...prev.slice(0, -1), { role: 'files', changes: [...last.changes, { path: event.path, content: event.content }] }]
        }
        return [...prev, { role: 'files', changes: [{ path: event.path, content: event.content }] }]
      })
    } else if (event.type === 'status') {
      setMessages(prev => [...prev, { role: 'status', content: event.message }])
    } else if (event.type === 'error') {
      finalizeAnalysis()
      setMessages(prev => [...prev, { role: 'error', content: event.message }])
    } else if (event.type === 'done') {
      finalizeAnalysis()
      setMessages(prev => [...prev, { role: 'done', filesChanged: event.filesChanged, answer: event.answer }])
    }
  }

  const readSSE = async (res: Response) => {
    const reader = res.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try { applyEvent(JSON.parse(data)) } catch {}
      }
    }
  }

  const runAgent = async (url: string, body: Record<string, unknown>) => {
    setLoading(true)
    analysisRef.current = ''
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        let msg = 'Agent failed'
        try { msg = JSON.parse(text).error || msg } catch { if (text) msg = text }
        setMessages(prev => [...prev, { role: 'error', content: msg }])
      } else {
        await readSSE(res)
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'error', content: e instanceof Error ? e.message : 'Failed' }])
    }
    setMessages(prev => prev.filter(m => m.role !== 'thinking'))
    setLoading(false)
  }

  const startAgent = async () => {
    if (!issue || started) return
    setStarted(true)
    setMessages([])
    await runAgent('/agent/start?stream=true', { sandboxId, issue })
  }

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const userMsg = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMsg }])
    await runAgent('/agent/chat?stream=true', { sandboxId, message: userMsg })
  }

  return (
    <div className="chat">
      <div className="chat-messages">
        {messages.length === 0 && !started && (
          <div className="chat-empty">
            <div className="empty-icon">&#x1F916;</div>
            <p>Click <strong>Analyze Issue</strong> to start</p>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i} className="msg msg-user">
                <div className="msg-content">{msg.content}</div>
              </div>
            )
          }

          if (msg.role === 'thinking') {
            return (
              <div key={i} className="msg msg-thinking">
                <span className="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
                <span className="thinking-text">Analyzing</span>
              </div>
            )
          }

          if (msg.role === 'analysis') {
            return (
              <div key={i} className="msg msg-analysis">
                <div className="msg-label">Analysis</div>
                <div className="msg-content">{msg.content}{msg._streaming && <span className="cursor">|</span>}</div>
              </div>
            )
          }

          if (msg.role === 'tool') {
            return (
              <div key={i} className="msg msg-tool">
                <div className="msg-label">
                  <span className="tool-name">{formatToolName(msg.name)}</span>
                  {msg.result && <span className="tool-check">✓</span>}
                </div>
                {!msg.result && <span className="tool-spinner" />}
                {msg.result && <div className="tool-result-text">{msg.result}</div>}
              </div>
            )
          }

          if (msg.role === 'files') {
            return (
              <div key={i} className="msg msg-files">
                <div className="msg-label">Changes ({msg.changes.length} file{msg.changes.length !== 1 ? 's' : ''})</div>
                {msg.changes.map((fc, j) => (
                  <div key={j} className="file-card">
                    <div className="file-card-header">{filePathShort(fc.path)}</div>
                    <pre className="file-card-content">{fc.content}</pre>
                  </div>
                ))}
              </div>
            )
          }

          if (msg.role === 'status') {
            return (
              <div key={i} className="msg msg-status">
                {msg.content}
              </div>
            )
          }

          if (msg.role === 'error') {
            return (
              <div key={i} className="msg msg-error">
                {msg.content}
              </div>
            )
          }

          if (msg.role === 'done') {
            return (
              <div key={i} className="msg msg-done">
                {msg.answer && <div className="msg-content">{msg.answer}</div>}
                {msg.filesChanged > 0 && (
                  <div className="done-note">
                    ✓ {msg.filesChanged} file(s) changed and committed
                  </div>
                )}
              </div>
            )
          }

          return null
        })}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input">
        {!started && issue ? (
          <button className="btn-primary btn-full" onClick={startAgent}>
            Analyze Issue
          </button>
        ) : (
          <div className="input-row">
            <input
              type="text"
              placeholder="Ask follow-up..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              disabled={loading}
            />
            <button onClick={sendMessage} disabled={loading || !input.trim()}>
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
