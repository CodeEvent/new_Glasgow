import { getConfig } from '../config/env';
import { AiAgent, DEFAULT_CLAUDE_MODEL } from './aiAgent';
import { DEFAULT_GEMINI_MODEL, GeminiAgent } from './geminiAgent';

/**
 * The AI helper to use, from the settings, or undefined (AI off).
 * auto: Gemini (free) if GEMINI_API_KEY is set, otherwise Claude if ANTHROPIC_API_KEY is set.
 */
export function createAiAgent(): AiAgent | GeminiAgent | undefined {
  const cfg = getConfig();
  const provider = cfg.AI_PROVIDER === 'auto' ? (cfg.GEMINI_API_KEY ? 'gemini' : cfg.ANTHROPIC_API_KEY ? 'claude' : null) : cfg.AI_PROVIDER;
  if (provider === 'gemini' && cfg.GEMINI_API_KEY) return new GeminiAgent(cfg.GEMINI_API_KEY, cfg.AI_MODEL ?? DEFAULT_GEMINI_MODEL);
  if (provider === 'claude' && cfg.ANTHROPIC_API_KEY) return new AiAgent(cfg.ANTHROPIC_API_KEY, cfg.AI_MODEL ?? DEFAULT_CLAUDE_MODEL);
  return undefined;
}
