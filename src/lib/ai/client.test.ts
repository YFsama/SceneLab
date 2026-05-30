import { describe, it, expect } from 'vitest';
import { sendMessageWithTools, DEFAULT_MODEL } from './client';
import type { FetchFn } from './client';
import type { AIMessage, AIToolCall, AIToolResult } from './types';

function mockFetch(responses: unknown[], capturedBodies: unknown[]): FetchFn {
  let i = 0;
  return async (_url, init) => {
    capturedBodies.push(JSON.parse(init.body as string));
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: true, status: 200, text: async () => '', json: async () => r };
  };
}

const userMsg = (content: string): AIMessage => ({ role: 'user', content, timestamp: 0 });

describe('sendMessageWithTools', () => {
  it('feeds tool results back and returns the final text', async () => {
    const bodies: unknown[] = [];
    const fetchFn = mockFetch(
      [
        {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'tu1', name: 'list_bodies', input: {} },
          ],
        },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'There are 0 bodies.' }] },
      ],
      bodies,
    );

    const executed: AIToolCall[] = [];
    const executeTool = async (call: AIToolCall): Promise<AIToolResult> => {
      executed.push(call);
      return { name: call.name, result: { count: 0 } };
    };

    const res = await sendMessageWithTools('key', [userMsg('how many bodies?')], executeTool, { fetchFn });

    expect(res.text).toBe('There are 0 bodies.');
    expect(res.toolResults).toHaveLength(1);
    expect(executed[0]!.id).toBe('tu1');
    expect(executed[0]!.name).toBe('list_bodies');

    // Two API calls; the second carries a tool_result for tu1.
    expect(bodies).toHaveLength(2);
    const second = bodies[1] as { model: string; system?: string; messages: Array<{ role: string; content: unknown }> };
    expect(second.model).toBe(DEFAULT_MODEL);
    expect(second.system).toMatch(/millimet/i); // system prompt grounds units
    const lastTurn = second.messages[second.messages.length - 1]!;
    expect(lastTurn.role).toBe('user');
    const block = (lastTurn.content as Array<{ type: string; tool_use_id?: string }>)[0]!;
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('tu1');
  });

  it('returns immediately when the model does not call a tool', async () => {
    const bodies: unknown[] = [];
    const fetchFn = mockFetch([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi!' }] }], bodies);
    const executeTool = async (c: AIToolCall): Promise<AIToolResult> => ({ name: c.name, result: null });
    const res = await sendMessageWithTools('key', [userMsg('hello')], executeTool, { fetchFn });
    expect(res.text).toBe('Hi!');
    expect(res.toolResults).toHaveLength(0);
    expect(bodies).toHaveLength(1);
  });

  it('marks tool errors with is_error in the result block', async () => {
    const bodies: unknown[] = [];
    const fetchFn = mockFetch(
      [
        { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'boom', input: {} }] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Handled.' }] },
      ],
      bodies,
    );
    const executeTool = async (c: AIToolCall): Promise<AIToolResult> => ({ name: c.name, result: null, error: 'nope' });
    const res = await sendMessageWithTools('key', [userMsg('do it')], executeTool, { fetchFn });
    expect(res.toolResults[0]!.error).toBe('nope');
    const second = bodies[1] as { messages: Array<{ content: unknown }> };
    const block = (second.messages[second.messages.length - 1]!.content as Array<{ is_error: boolean }>)[0]!;
    expect(block.is_error).toBe(true);
  });

  it('makes a final tool-free summary call when iterations are exhausted', async () => {
    const bodies: unknown[] = [];
    const toolTurn = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'list_bodies', input: {} }],
    };
    // The model keeps asking for tools; after maxIterations a no-tools call
    // elicits this closing summary.
    const fetchFn = mockFetch(
      [toolTurn, toolTurn, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done after summary.' }] }],
      bodies,
    );
    let calls = 0;
    const executeTool = async (c: AIToolCall): Promise<AIToolResult> => {
      calls += 1;
      return { name: c.name, result: { count: 0 } };
    };

    const res = await sendMessageWithTools('key', [userMsg('go')], executeTool, { fetchFn, maxIterations: 2 });

    expect(calls).toBe(2); // one tool per allowed iteration
    expect(res.text).toBe('Done after summary.');
    // 2 loop iterations + 1 closing call.
    expect(bodies).toHaveLength(3);
    // The closing call must omit tools so the model has to answer in text.
    expect((bodies[2] as { tools?: unknown }).tools).toBeUndefined();
  });
});
