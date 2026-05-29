export type { AITool, AIMessage, AIConfig, AIToolCall, AIToolResult } from './types';
export { registerTool, unregisterTool, getTool, getAllTools, getToolDefinitions, clearTools } from './toolRegistry';
export { sendMessage, executeToolCall, DEFAULT_MODEL } from './client';
export { registerBuiltinTools } from './builtinTools';
export { isString, isNumber, isBoolean, isVec3, isStringArray, assertString, assertNumber, assertBoolean, assertVec3, assertStringArray, assertEnum } from './validate';
