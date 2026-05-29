import type { AITool } from './types';

const tools = new Map<string, AITool>();

export function registerTool(tool: AITool): void {
  tools.set(tool.name, tool);
}

export function unregisterTool(name: string): void {
  tools.delete(name);
}

export function getTool(name: string): AITool | undefined {
  return tools.get(name);
}

export function getAllTools(): AITool[] {
  return Array.from(tools.values());
}

export function getToolDefinitions(): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function clearTools(): void {
  tools.clear();
}
