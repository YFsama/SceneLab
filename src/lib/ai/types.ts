export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface AIConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface AIToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIToolResult {
  name: string;
  result: unknown;
  error?: string;
}
