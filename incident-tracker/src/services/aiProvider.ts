import { getConfig } from '../config/env';
import { AiAgent, DEFAULT_CLAUDE_MODEL } from './aiAgent';
import { DEFAULT_GEMINI_MODEL, GeminiAgent } from './geminiAgent';
import { DEFAULT_COMPAT_BASE_URL, DEFAULT_COMPAT_MODEL, OpenAiCompatAgent } from './openaiCompatAgent';

/**
 * The AI helper to use, from the settings, or undefined (AI off).
 * auto: Groq (free) if GROQ_API_KEY is set, else Gemini (free) if GEMINI_API_KEY, else Claude.
 */
export function createAiAgent(): AiAgent | GeminiAgent | OpenAiCompatAgent | undefined {
  const cfg = getConfig();
  const provider =
    cfg.AI_PROVIDER === 'auto'
      ? cfg.GROQ_API_KEY ? 'groq' : cfg.GEMINI_API_KEY ? 'gemini' : cfg.ANTHROPIC_API_KEY ? 'claude' : null
      : cfg.AI_PROVIDER;
  if (provider === 'groq' && cfg.GROQ_API_KEY) {
    return new OpenAiCompatAgent(cfg.GROQ_API_KEY, cfg.AI_MODEL ?? DEFAULT_COMPAT_MODEL, cfg.AI_BASE_URL ?? DEFAULT_COMPAT_BASE_URL);
  }
  if (provider === 'gemini' && cfg.GEMINI_API_KEY) return new GeminiAgent(cfg.GEMINI_API_KEY, cfg.AI_MODEL ?? DEFAULT_GEMINI_MODEL);
  if (provider === 'claude' && cfg.ANTHROPIC_API_KEY) return new AiAgent(cfg.ANTHROPIC_API_KEY, cfg.AI_MODEL ?? DEFAULT_CLAUDE_MODEL);
  return undefined;
}
