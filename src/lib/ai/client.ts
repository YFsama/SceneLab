import type { AIMessage, AIToolCall, AIToolResult } from './types';
import { getAllTools } from './toolRegistry';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string;
}

/** Default model for the AI panel — current Sonnet. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export async function sendMessage(
  apiKey: string,
  messages: AIMessage[],
  model = DEFAULT_MODEL,
  maxTokens = 4096,
  viewportScreenshot?: string,
): Promise<{ text: string; toolCalls: AIToolCall[] }> {
  const allTools = getAllTools();

  const anthropicMessages: AnthropicMessage[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // Add viewport screenshot to the last user message if provided
  if (viewportScreenshot && anthropicMessages.length > 0) {
    const lastMsg = anthropicMessages[anthropicMessages.length - 1]!;
    if (lastMsg.role === 'user') {
      lastMsg.content = [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: viewportScreenshot } },
        { type: 'text', text: typeof lastMsg.content === 'string' ? lastMsg.content : '' },
      ];
    }
  }

  const toolDefs: AnthropicToolDef[] = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    tools: toolDefs.length > 0 ? toolDefs : undefined,
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as AnthropicResponse;

  let text = '';
  const toolCalls: AIToolCall[] = [];

  for (const block of data.content) {
    if (block.type === 'text') {
      text += block.text ?? '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        name: block.name ?? '',
        arguments: block.input ?? {},
      });
    }
  }

  return { text, toolCalls };
}

export async function executeToolCall(toolCall: AIToolCall): Promise<AIToolResult> {
  const tools = getAllTools();
  const tool = tools.find((t) => t.name === toolCall.name);

  if (!tool) {
    return {
      name: toolCall.name,
      result: null,
      error: `Tool "${toolCall.name}" not found`,
    };
  }

  try {
    const result = await tool.execute(toolCall.arguments);
    return { name: toolCall.name, result };
  } catch (e) {
    return {
      name: toolCall.name,
      result: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
