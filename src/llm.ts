import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';

export interface StructuredCallOptions {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export class Llm {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(cfg: Config) {
    this.client = new Anthropic({ apiKey: cfg.apiKey }); // SDK auto-retries 429/5xx
    this.model = cfg.model;
  }

  /** One forced tool-use call; returns the tool input. Callers validate the shape. */
  async structured<T>(opts: StructuredCallOptions): Promise<T> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      tools: [{ name: opts.toolName, description: opts.toolDescription, input_schema: opts.schema as Anthropic.Tool['input_schema'] }],
      tool_choice: { type: 'tool', name: opts.toolName },
    });
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) throw new Error(`LLM returned no ${opts.toolName} tool call (stop_reason: ${res.stop_reason})`);
    return block.input as T;
  }
}
