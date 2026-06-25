import { useState, useRef, useEffect } from 'react'
import { AGENTS } from '../../lib/mockData'

interface Props {
  agentId: string
  onClose: () => void
}

interface Message {
  role: 'user' | 'agent'
  content: string
  timestamp: Date
}

export default function AgentChatModal({ agentId, onClose }: Props) {
  const agent = AGENTS.find(a => a.id === agentId)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (agent) {
      // Initial greeting
      setTimeout(() => {
        setMessages([{
          role: 'agent',
          content: agent.greeting,
          timestamp: new Date()
        }])
      }, 500)
    }
  }, [agent])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || !agent || isTyping) return

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: new Date()
    }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsTyping(true)

    try {
      const res = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId, message: userMessage.content }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        role: 'agent',
        content: data.response || 'No response.',
        timestamp: new Date()
      }])
    } catch {
      setMessages(prev => [...prev, {
        role: 'agent',
        content: 'Connection to crew lost. Try again shortly.',
        timestamp: new Date()
      }])
    } finally {
      setIsTyping(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!agent) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-[600px] h-[600px] flex flex-col bg-[var(--bg0)] border border-[var(--border)]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div 
              className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold"
              style={{ 
                background: `${agent.color}18`,
                border: `1px solid ${agent.color}44`,
                color: agent.color
              }}
            >
              {agent.name[0]}
            </div>
            <div>
              <h3 className="font-display text-[14px] font-semibold text-white">
                {agent.name}
              </h3>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  agent.status === 'online' ? 'bg-[var(--green)]' :
                  agent.status === 'standby' ? 'bg-[var(--amber)]' : 'bg-[var(--purple)]'
                } animate-[pulse-dot_2s_ease-in-out_infinite]`} />
                <span className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.5)]">
                  {agent.status.toUpperCase()} · {agent.version}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center text-[rgba(255,160,0,0.5)] hover:text-[var(--amber)] bg-transparent border border-[var(--border)] hover:border-[var(--amber2)] transition-all cursor-pointer"
          >
            &times;
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] p-3 ${
                  msg.role === 'user'
                    ? 'bg-[rgba(255,140,0,0.12)] border-[var(--amber2)]'
                    : 'bg-[rgba(0,255,204,0.06)] border-[rgba(0,255,204,0.25)]'
                } border`}
              >
                <p className="text-[11px] tracking-[0.04em] text-[rgba(255,160,0,0.85)] leading-[1.8]">
                  {msg.content}
                </p>
                <div className="text-[7px] tracking-[0.08em] text-[rgba(255,160,0,0.3)] mt-2">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
          
          {isTyping && (
            <div className="flex justify-start">
              <div className="px-4 py-2 bg-[rgba(0,255,204,0.04)] border border-[rgba(0,255,204,0.15)]">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[typing_1s_ease-in-out_infinite_0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[typing_1s_ease-in-out_infinite_150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[typing_1s_ease-in-out_infinite_300ms]" />
                </div>
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Files Panel */}
        <div className="px-4 py-2 border-t border-[var(--border)]">
          <div className="text-[7px] tracking-[0.12em] text-[rgba(255,160,0,0.35)] uppercase mb-1">
            Bound Files
          </div>
          <div className="flex flex-wrap gap-1">
            {agent.files.map((file, i) => (
              <span
                key={i}
                className={`px-2 py-0.5 text-[7px] tracking-[0.06em] border ${
                  file.status === 'live' 
                    ? 'border-[var(--green)] text-[var(--green)]' 
                    : 'border-[var(--border)] text-[rgba(255,160,0,0.5)]'
                }`}
              >
                {file.name}
              </span>
            ))}
          </div>
        </div>

        {/* Input */}
        <div className="p-4 border-t border-[var(--border)]">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent..."
              className="flex-1 px-4 py-2 bg-[rgba(255,140,0,0.04)] border border-[var(--border)] focus:border-[var(--amber2)] outline-none text-[11px] tracking-[0.04em] text-[var(--amber)] placeholder:text-[rgba(255,160,0,0.3)] font-mono"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isTyping}
              className="px-5 py-2 text-[9px] tracking-[0.12em] uppercase border border-[var(--amber2)] text-[var(--amber)] bg-[rgba(255,140,0,0.1)] hover:bg-[rgba(255,140,0,0.2)] disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer font-mono"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
