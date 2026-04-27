import { useEffect, useRef } from 'react'
import { MessageSquare, Trash2, Mic, Bot } from 'lucide-react'
import { useCallStore, Message } from '../../store/callStore'

export default function TranscriptPanel() {
  const { messages, clearConversation } = useCallStore()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  return (
    <div className="card flex flex-col h-full min-h-[300px]">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h3 className="section-title">
          <MessageSquare className="w-4 h-4 text-primary" />
          Conversation
        </h3>
        {messages.length > 0 && (
          <button
            onClick={clearConversation}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            <Trash2 className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      <div className={`flex-1 pr-1 space-y-3 ${messages.length === 0 ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center select-none gap-2">
            <div className="w-10 h-10 rounded-2xl bg-muted border border-border flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-muted-foreground/40" />
            </div>
            <p className="text-muted-foreground text-sm font-medium">No conversation yet</p>
            <p className="text-muted-foreground/60 text-xs">Start a call to see the transcript</p>
          </div>
        ) : (
          messages.map((msg: Message) => (
            <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
                msg.role === 'user'
                  ? 'bg-primary/10 border border-primary/25'
                  : 'bg-muted border border-border'
              }`}>
                {msg.role === 'user'
                  ? <Mic className="w-3 h-3 text-primary" />
                  : <Bot className="w-3 h-3 text-muted-foreground" />
                }
              </div>
              <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-primary/8 border border-primary/20 text-foreground'
                  : 'bg-muted border border-border text-foreground'
              }`}>
                {msg.text}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
