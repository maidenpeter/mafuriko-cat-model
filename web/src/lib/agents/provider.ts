import * as gemini from "./gemini";
import * as openai from "./openai";
import type { Role } from "./schema";

export type { Generated, Usage } from "./gemini";

const PROVIDERS = { openai, gemini };
export type ProviderName = keyof typeof PROVIDERS;

/**
 * Which service runs the agents. AGENT_PROVIDER decides; left blank, it is OpenAI when
 * an OpenAI key is set and Gemini otherwise.
 */
export function providerName(): ProviderName {
  const chosen = process.env.AGENT_PROVIDER?.trim().toLowerCase();
  if (chosen === "openai" || chosen === "gemini") return chosen;
  return process.env.OPENAI_API_KEY?.trim() ? "openai" : "gemini";
}

const active = () => PROVIDERS[providerName()];

export const modelName = () => active().modelName();

export const keyFor = (role: Role) => active().keyFor(role);

/** The settings that would give this agent a key, for the message shown when it has none. */
export function keySettings(role: Role): string {
  const prefix = `${providerName().toUpperCase()}_API_KEY`;
  return `${prefix}_${role.toUpperCase()} or ${prefix}`;
}

/**
 * One text-in, JSON-text-out call. The routes call this and nothing else, so the two
 * provider files are the only places that know how a model is reached.
 */
export const generateJson: typeof gemini.generateJson = (...args) => active().generateJson(...args);
