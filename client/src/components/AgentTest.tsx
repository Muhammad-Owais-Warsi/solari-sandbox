import { useState, useRef, useEffect } from 'react'

type ToolCall = {
  id: string
  name: string
  args: Record<string, any>
}

type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool_call'; call: ToolCall; status: 'pending' | 'approved' | 'rejected' | 'executed'; result?: string }

export function AgentTest() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const processEvents = (events: any[]) => {
    for (const event of events) {
      if (event.type === 'message') {
        setMessages(prev => [...prev, { role: 'assistant', content: event.content }])
      } else if (event.type === 'tool_call') {
        setMessages(prev => [...prev, { role: 'tool_call', call: event.call, status: 'pending' }])
      } else if (event.type === 'tool_result') {
        setMessages(prev =>
          prev.map(m =>
            m.role === 'tool_call' && m.call.id === event.callId
              ? { ...m, status: 'executed' as const, result: event.result }
              : m
          )
        )
      } else if (event.type === 'error') {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${event.message}` }])
      }
    }
  }

  const send = async () => {
    if (!input.trim() || loading) return
    const msg = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    setLoading(true)

    try {
      const res = await fetch('/agent/chat-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error}` }])
      } else if (data.events) {
        processEvents(data.events)
      } else if (data.reply) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e instanceof Error ? e.message : 'Failed'}` }])
    }
    setLoading(false)
  }

  const formatToolName = (name: string) =>
    name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div className="agent-test">
      <h2>Agent Test (No Sandbox)</h2>
      <div className="test-messages">
        {messages.length === 0 && (
          <div className="test-empty">Type a message to test the agent</div>
        )}
        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i} className="msg msg-user">
                <div className="msg-content">{msg.content}</div>
              </div>
            )
          }
          if (msg.role === 'assistant') {
            return (
              <div key={i} className="msg msg-assistant">
                <div className="msg-label">Agent</div>
                <div className="msg-content">{msg.content}</div>
              </div>
            )
          }
          if (msg.role === 'tool_call') {
            return (
              <div key={i} className={`msg msg-tool tool-${msg.status}`}>
                <div className="msg-label">
                  {formatToolName(msg.call.name)}
                  <span className={`tool-badge badge-${msg.status}`}>{msg.status}</span>
                </div>
                <pre className="tool-args">{JSON.stringify(msg.call.args, null, 2)}</pre>
                {msg.result && (
                  <pre className="tool-result">{msg.result.slice(0, 500)}{msg.result.length > 500 ? '...' : ''}</pre>
                )}
              </div>
            )
          }
          return null
        })}
        {loading && (
          <div className="msg msg-assistant thinking">
            <div className="msg-label">Agent</div>
            <div className="msg-content thinking-dots"><span>.</span><span>.</span><span>.</span></div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="test-input">
        <input
          type="text"
          placeholder="Ask the agent..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          disabled={loading}
        />
        <button onClick={send} disabled={loading || !input.trim()}>Send</button>
      </div>
    </div>
  )
}
