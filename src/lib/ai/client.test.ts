import { describe, it, expect } from 'vitest';
import { sendMessageWithTools, DEFAULT_MODEL, SYSTEM_PROMPT } from './client';
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

describe('SYSTEM_PROMPT', () => {
  it('grounds units and points at the key workflows', () => {
    expect(SYSTEM_PROMPT).toMatch(/millimet/i);
    expect(SYSTEM_PROMPT).toMatch(/\+Y/); // build axis
    expect(SYSTEM_PROMPT).toContain('add_constraint'); // parametric sketches
    expect(SYSTEM_PROMPT).toContain('lay_flat'); // print prep
    expect(SYSTEM_PROMPT).toContain('compute_mass_properties'); // simulation
  });

  it('teaches the major categories and the multi-body gotcha', () => {
    expect(SYSTEM_PROMPT).toContain('boolean_op'); // booleans
    expect(SYSTEM_PROMPT).toContain('hollow_body');
    expect(SYSTEM_PROMPT).toContain('sweep');
    expect(SYSTEM_PROMPT).toContain('import_mesh'); // interop
    expect(SYSTEM_PROMPT).toContain('export_body');
    expect(SYSTEM_PROMPT).toContain('export_file'); // real file delivery
    expect(SYSTEM_PROMPT).toContain('export_drawing'); // drawing sheet SVG delivery
    expect(SYSTEM_PROMPT).toContain('insert_library_part'); // parts library
    expect(SYSTEM_PROMPT).toContain('suggest_feeds_speeds'); // CAM
    expect(SYSTEM_PROMPT).toContain('add_drawing_note'); // drawing sheet
    expect(SYSTEM_PROMPT).toContain('set_body_appearance'); // presentation
    expect(SYSTEM_PROMPT).toContain('counterbore'); // hole variants
    expect(SYSTEM_PROMPT).toContain('update_feature'); // parametric edits
    expect(SYSTEM_PROMPT).toContain('list_features');
    // bodyId defaults to the FIRST body — the model must name the target.
    expect(SYSTEM_PROMPT).toMatch(/FIRST body/);
  });

  it('teaches the takeover capabilities by workflow (tree control, undo, sketch read-back, edges)', () => {
    // Feature-tree control + tree-aware modify routing.
    expect(SYSTEM_PROMPT).toContain('remove_feature');
    expect(SYSTEM_PROMPT).toContain('set_feature_suppressed');
    expect(SYSTEM_PROMPT).toContain('reorder_feature');
    expect(SYSTEM_PROMPT).toMatch(/prefer feature\s+edits for tree bodies/i);
    // Undo as the recovery move.
    expect(SYSTEM_PROMPT).toMatch(/call\s+undo immediately/i);
    // Sketch read-back + driving dimensions.
    expect(SYSTEM_PROMPT).toContain('list_sketch_entities');
    expect(SYSTEM_PROMPT).toContain('update_sketch_constraint');
    // Edge addressing for fillet/chamfer.
    expect(SYSTEM_PROMPT).toContain('list_edges');
    expect(SYSTEM_PROMPT).toContain('edgeIds');
    // Workspace switching and body management.
    expect(SYSTEM_PROMPT).toContain('set_workspace');
    expect(SYSTEM_PROMPT).toContain('set_body_hidden');
    expect(SYSTEM_PROMPT).toContain('rename_body');
    // Honesty about export (no file saved by the tool) and feature-mode fillets.
    expect(SYSTEM_PROMPT).toMatch(/export_body\s+validates\/counts/i);
    expect(SYSTEM_PROMPT).toMatch(/ALL edges/i);
  });
});

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

  it('marks a RETURNED { success: false } payload with is_error too (not just thrown errors)', async () => {
    const bodies: unknown[] = [];
    const fetchFn = mockFetch(
      [
        { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'delete_body', input: {} }] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'It was not there.' }] },
      ],
      bodies,
    );
    const executeTool = async (c: AIToolCall): Promise<AIToolResult> => ({
      name: c.name,
      result: { success: false, reason: 'body not found' },
    });
    const res = await sendMessageWithTools('key', [userMsg('delete it')], executeTool, { fetchFn });
    expect(res.toolResults[0]!.error).toBeUndefined(); // returned, not thrown
    const second = bodies[1] as { messages: Array<{ content: unknown }> };
    const block = (second.messages[second.messages.length - 1]!.content as Array<{ is_error: boolean; content: string }>)[0]!;
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('body not found'); // payload still delivered
  });

  it('does not flag successful tool payloads as errors', async () => {
    const bodies: unknown[] = [];
    const fetchFn = mockFetch(
      [
        { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'create_box', input: {} }] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Made it.' }] },
      ],
      bodies,
    );
    const executeTool = async (c: AIToolCall): Promise<AIToolResult> => ({
      name: c.name,
      result: { success: true, bodyId: 'b1' },
    });
    await sendMessageWithTools('key', [userMsg('make a box')], executeTool, { fetchFn });
    const second = bodies[1] as { messages: Array<{ content: unknown }> };
    const block = (second.messages[second.messages.length - 1]!.content as Array<{ is_error: boolean }>)[0]!;
    expect(block.is_error).toBe(false);
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

  it('defaults to 16 iterations — enough for a full part (was 5)', async () => {
    const bodies: unknown[] = [];
    const toolTurn = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'list_bodies', input: {} }],
    };
    const fetchFn = mockFetch([toolTurn], bodies); // every call wants a tool
    let calls = 0;
    const executeTool = async (c: AIToolCall): Promise<AIToolResult> => {
      calls += 1;
      return { name: c.name, result: { count: 0 } };
    };

    await sendMessageWithTools('key', [userMsg('build it all')], executeTool, { fetchFn });

    // The default budget ran to exhaustion: 16 tool iterations + 1 closing
    // tool-free summary call.
    expect(calls).toBe(16);
    expect(bodies).toHaveLength(17);
    expect((bodies[16] as { tools?: unknown }).tools).toBeUndefined();
  });
});
