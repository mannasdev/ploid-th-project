export interface Config {
  apiKey: string;
  model: string;
  dbPath: string;
}

/** DB path resolution for CLIs that never touch the API (no key required). */
export function resolveDbPath(): string {
  return process.env['MEMORY_DB'] ?? './memory.db';
}

export function loadConfig(): Config {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Export it before running (see README).');
  }
  return {
    apiKey,
    model: process.env['MEMORY_MODEL'] ?? 'claude-haiku-4-5',
    dbPath: resolveDbPath(),
  };
}
