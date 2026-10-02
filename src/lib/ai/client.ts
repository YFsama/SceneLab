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
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** System prompt grounding the assistant as SceneLab's CAD/3D-print helper.
 * Teaches by CATEGORY and workflow (the model sees the exact tool list in the
 * API request — don't enumerate every tool here), plus the gotchas that trip
 * an LLM driver: multi-body id resolution, pick-before-modify, parametric
 * edits via the feature tree. */
export const SYSTEM_PROMPT = [
  'You are the modeling assistant for SceneLab, an AI-first 3D CAD/CAM app.',
  'Help the user design parts for CAD and 3D printing by driving the provided',
  'tools. All dimensions are in millimetres; the build (up) axis is +Y. Prefer',
  'calling a tool over assuming a result, and after acting give a short,',
  'concrete confirmation.',
  'MODELING: create solids with the create_* primitives (box, cylinder, sphere,',
  'cone, torus, wedge, prism, tube, frustum tube, coil), or sketch on a plane',
  '(create_sketch, then draw_*) and extrude/revolve; sweep a profile along a 3D',
  'path; combine solids with boolean_op (union/difference/intersect —',
  'voxel-based, raise resolution for detail) and hollow_body for lightweighting;',
  'drill with create_hole (diameter + depth or through-all, straight down from',
  'the top face by default or at explicit x/y/z; supports counterbore and',
  'countersink widenings). Pattern with linear_array, grid_array,',
  'circular_array, mirror, mirror_merge; edit with move/rotate/scale/resize,',
  'convex_hull, center_body, split_by_plane.',
  'PARAMETRIC EDITS: list_features shows the feature tree (ids, types,',
  'summaries); update_feature patches a feature\'s params (e.g. make the extrude',
  '30 mm, the fillet r3) and the model recomputes — prefer this over redoing',
  'geometry when the user asks to change a dimension of an existing feature.',
  'SKETCHING (Fusion-style): constrain sketches with add_constraint (horizontal,',
  'vertical, parallel, perpendicular, coincident, concentric, equal, distance,',
  'radius, fixed); refine with trim_sketch_entity (remove the clicked piece at',
  'crossings), extend_sketch_entity (to the nearest boundary),',
  'offset_sketch_entity (equidistant copy, signed distance) — all take entity',
  'ids from the draw_* tools plus a sketch-space point.',
  'MULTI-BODY GOTCHA: tools that take bodyId default to the FIRST body when it',
  'is omitted. In a scene with several bodies, name the target body explicitly',
  'or call list_bodies / describe_scene first — otherwise you will silently',
  'modify the wrong part.',
  'REFERENCE GEOMETRY: datum planes, axes, points and coordinate systems',
  '(list_*/create_* tools) exist to drive placement — patterns about axes,',
  'splits by planes, bodies placed into coordinate systems.',
  'INTEROP: import_mesh reads STL/OBJ/STEP text into the scene; export_body',
  'writes STL/OBJ/3MF/STEP. insert_library_part drops in prebuilt parts;',
  'load_sample_project opens a starter project.',
  'MEASURE & ANALYSIS: measure_distance / measure_face_area / measure_face_angle',
  '/ get_dimensions / list_faces for geometry; analyze_*,',
  'check_print_readiness, recommend_orientation, find_weak_section,',
  'slice_cross_section and estimate_* for printability; compute_mass_properties',
  'and pendulum_period for simulation; analyze_symmetry for symmetry checks.',
  'CAM: suggest_feeds_speeds recommends spindle RPM and feed rates. Drawing',
  'sheet: add_drawing_note for remarks/callouts. Presentation:',
  'set_body_appearance (color/opacity/material), select_body to highlight,',
  'set_view/set_projection for the camera.',
  'PRINT PREP: before printing use orient_for_print or lay_flat, seat_on_bed,',
  'scale_to_fit for oversized parts, arrange_on_plate for batches, and',
  'repair_mesh for non-watertight meshes.',
  'VISION: when a viewport image is attached and the user refers to something',
  'visible in it ("shell this wall", "fillet this side"), estimate the point',
  'over that feature as x,y normalized 0..1 of the image (origin top-left, y',
  'down), call select_face_at_viewport, then pass the returned faceId to',
  'shell/fillet in the same turn — face ids regenerate after every edit, so',
  'always pick before the modifying tool, and pick again after any set_view or',
  'geometry change. On a miss, adjust the point toward the feature center and',
  'retry at most once. Use additive=true when several faces are wanted, and',
  'clear_face_selection when done.',
].join(' ');

function toolDefinitions(): AnthropicToolDef[] {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));
}

function toAnthropicMessages(messages: AIMessage[], screenshot?: string): AnthropicMessage[] {
  const out: AnthropicMessage[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  if (screenshot && out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.role === 'user') {
      last.content = [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
        { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
      ];
    }
  }
  return out;
}

async function postMessages(
  fetchFn: FetchFn,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<AnthropicResponse> {
  const response = await fetchFn(ANTHROPIC_API_URL, {
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
    throw new Error(`API error: ${response.status} - ${await response.text()}`);
  }
  return (await response.json()) as AnthropicResponse;
}

export interface AgentResult {
  text: string;
  toolResults: AIToolResult[];
}

/**
 * Run the Claude tool-use loop: send the conversation, execute any requested
 * tools, feed the tool_result blocks back, and repeat until the model stops
 * calling tools (or maxIterations is hit). This is the correct agentic
 * protocol — the model sees each tool's result and can reason from it.
 */
export async function sendMessageWithTools(
  apiKey: string,
  messages: AIMessage[],
  executeTool: (call: AIToolCall) => Promise<AIToolResult>,
  opts: {
    model?: string;
    maxTokens?: number;
    screenshot?: string;
    maxIterations?: number;
    fetchFn?: FetchFn;
  } = {},
): Promise<AgentResult> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const maxIterations = opts.maxIterations ?? 5;
  const tools = toolDefinitions();

  const aMsgs = toAnthropicMessages(messages, opts.screenshot);
  const toolResults: AIToolResult[] = [];
  let finalText = '';

  for (let iter = 0; iter < maxIterations; iter++) {
    const data = await postMessages(fetchFn, apiKey, {
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: aMsgs,
      tools: tools.length > 0 ? tools : undefined,
    });

    let text = '';
    const calls: AIToolCall[] = [];
    for (const block of data.content) {
      if (block.type === 'text') text += block.text ?? '';
      else if (block.type === 'tool_use') {
        calls.push({ name: block.name ?? '', arguments: block.input ?? {}, id: block.id });
      }
    }
    if (text) finalText = text;

    if (data.stop_reason !== 'tool_use' || calls.length === 0) {
      return { text: finalText, toolResults };
    }

    // Echo the assistant's tool_use turn, then return matching tool_result blocks.
    aMsgs.push({ role: 'assistant', content: data.content as Array<{ type: string; [k: string]: unknown }> });
    const resultBlocks: Array<{ type: string; [k: string]: unknown }> = [];
    for (const call of calls) {
      const r = await executeTool(call);
      toolResults.push(r);
      // Per Anthropic's protocol the model must SEE failures: flag both thrown
      // errors (r.error) and tools that RETURNED a failure payload
      // ({ success: false, ... }) instead of throwing.
      const returnedFailure =
        !r.error &&
        r.result !== null &&
        typeof r.result === 'object' &&
        (r.result as { success?: unknown }).success === false;
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(r.error ? { error: r.error } : r.result),
        is_error: Boolean(r.error) || returnedFailure,
      });
    }
    aMsgs.push({ role: 'user', content: resultBlocks });
  }

  // Iterations exhausted while the model still wanted tools. Make one final call
  // with no tools available so it must summarize in text, instead of leaving the
  // user with empty or stale output after the last tool ran.
  const closing = await postMessages(fetchFn, apiKey, {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: aMsgs,
  });
  let closingText = '';
  for (const block of closing.content) {
    if (block.type === 'text') closingText += block.text ?? '';
  }
  if (closingText) finalText = closingText;

  return { text: finalText, toolResults };
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
  const toolDefs = toolDefinitions();
  const data = await postMessages(fetch as unknown as FetchFn, apiKey, {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: toAnthropicMessages(messages, viewportScreenshot),
    tools: toolDefs.length > 0 ? toolDefs : undefined,
  });

  let text = '';
  const toolCalls: AIToolCall[] = [];
  for (const block of data.content) {
    if (block.type === 'text') {
      text += block.text ?? '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({ name: block.name ?? '', arguments: block.input ?? {}, id: block.id });
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
