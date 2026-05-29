import { useState, useRef, useEffect, useCallback } from 'react';
import { useT } from '../../lib/i18n';
import { sendMessageWithTools, executeToolCall, registerBuiltinTools } from '../../lib/ai';
import type { AIMessage } from '../../lib/ai';
import { showToast } from '../../lib/toast';
import { Bot, Send, Settings, X, Loader2, Eye } from 'lucide-react';

let toolsRegistered = false;

export function AIPanel() {
  const { t } = useT();
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!toolsRegistered) {
      registerBuiltinTools();
      toolsRegistered = true;
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;
    if (!apiKey) {
      setShowSettings(true);
      showToast(t('ai.setApiKey'), 'warning');
      return;
    }

    const userMessage: AIMessage = {
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };

    // Use functional updater to get latest messages
    let currentMessages: AIMessage[] = [];
    setMessages((prev) => {
      currentMessages = [...prev, userMessage];
      return currentMessages;
    });
    setInput('');
    setLoading(true);

    try {
      // Capture viewport screenshot if vision is enabled
      let screenshot: string | undefined;
      if (visionEnabled) {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          screenshot = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
        }
      }

      // Run the full tool-use loop so the model sees each tool's result.
      const { text, toolResults } = await sendMessageWithTools(
        apiKey,
        currentMessages,
        executeToolCall,
        { screenshot },
      );

      let assistantContent = text;
      if (toolResults.length > 0) {
        const summary = toolResults
          .map((r) => (r.error ? `Tool "${r.name}" error: ${r.error}` : `Tool "${r.name}": ${JSON.stringify(r.result)}`))
          .join('\n');
        assistantContent = `${text}${text ? '\n\n' : ''}${summary}`;
      }

      const assistantMessage: AIMessage = {
        role: 'assistant',
        content: assistantContent || t('ai.done'),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      showToast(`${t('ai.error')}: ${errMsg}`, 'error');
      const errorMessage: AIMessage = {
        role: 'assistant',
        content: `${t('ai.error')}: ${errMsg}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, apiKey, visionEnabled, t]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="fixed bottom-12 right-4 w-10 h-10 rounded-full bg-accent text-white flex items-center justify-center shadow-lg hover:bg-accent-hover transition-colors z-40"
        aria-label={t('ai.openAssistant')}
      >
        <Bot size={20} />
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-12 right-4 w-80 h-96 bg-panel border border-panel-border rounded-lg shadow-xl flex flex-col z-40"
      role="complementary"
      aria-label={t('ai.title')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-panel-border">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">{t('ai.title')}</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-1 text-text-muted hover:text-text-primary"
            aria-label={t('ai.settings')}
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => setExpanded(false)}
            className="p-1 text-text-muted hover:text-text-primary"
            aria-label={t('ai.closePanel')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Settings */}
      {showSettings && (
        <div className="px-3 py-2 border-b border-panel-border bg-surface">
          <label htmlFor="ai-api-key" className="block text-xs text-text-muted mb-1">{t('ai.apiKey')}</label>
          <input
            id="ai-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            className="w-full px-2 py-1 text-xs bg-panel border border-panel-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-text-muted text-center py-8">
            {t('ai.placeholder')}
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg text-xs ${
                msg.role === 'user'
                  ? 'bg-accent text-white'
                  : 'bg-surface text-text-primary'
              }`}
            >
              <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-surface px-3 py-2 rounded-lg">
              <Loader2 size={14} className="animate-spin text-text-muted" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-panel-border p-2">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('ai.inputPlaceholder')}
            rows={1}
            className="flex-1 px-2 py-1 text-xs bg-surface border border-panel-border rounded resize-none text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            onClick={() => setVisionEnabled(!visionEnabled)}
            className={`p-1.5 rounded transition-colors ${
              visionEnabled
                ? 'bg-accent text-white'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'
            }`}
            aria-label={t('ai.vision')}
            aria-pressed={visionEnabled}
            title={t('ai.vision')}
          >
            <Eye size={14} />
          </button>
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="p-1.5 bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={t('ai.sendMessage')}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
