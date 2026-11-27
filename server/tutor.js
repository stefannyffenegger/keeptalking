import Anthropic from '@anthropic-ai/sdk';
import { UPDATE_SCHEMA } from '../public/content.js';

const MODEL = process.env.TUTOR_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 20;
const MAX_CHARS = 500;
const MAX_PROMPT_CHARS = 40_000;

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your next conversational line in the target language.' },
    translation: { type: 'string', description: 'English translation of reply.' },
    correction: {
      type: 'object',
      properties: {
        needed: { type: 'boolean' },
        corrected: { type: 'string', description: "The learner's last message, corrected. Empty if not needed." },
        explanation: { type: 'string', description: 'One short English sentence. Empty if not needed.' },
      },
      required: ['needed', 'corrected', 'explanation'],
      additionalProperties: false,
    },
  },
  required: ['reply', 'translation', 'correction'],
  additionalProperties: false,
};

const systemPrompt = ({ language, scenario, level, voice }) => `You are a friendly ${language} conversation partner for an adult learner who can read the script but needs practice with everyday speech and sentence building.

Scenario: ${scenario}
Learner level: ${level} of 3. At level 1 use very short, common sentences. At level 3 use natural everyday speech with linked clauses.
The learner speaks using: ${voice}. Use forms that fit this when correcting their sentences.

Stay in the scenario and keep each reply to one or two short sentences, ending so the learner has something easy to answer. Write natural spoken ${language}, not textbook phrasing. Do not use romanization.

Check the learner's last message. Mark a correction only for a real error or something a native speaker would not say; leave style preferences alone. If the learner writes in English, set needed to true and give the ${language} way to say it.`;

export function validateTutorRequest(body) {
  const { language, scenario, level, voice, messages } = body ?? {};
  const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!text(language, 40) || !text(scenario, 120) || !text(voice, 40) || ![1, 2, 3].includes(level)) return null;
  if (!Array.isArray(messages) || messages.length > MAX_TURNS) return null;
  if (!messages.every((m) => ['user', 'assistant'].includes(m?.role) && text(m.content, MAX_CHARS))) return null;
  if (messages.length && (messages[0].role !== 'user' || messages.at(-1).role !== 'user')) return null;
  return { language, scenario, level, voice, messages };
}

export function createTutor(client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null) {
  if (!client) return null;
  return async function reply(request) {
    const messages = request.messages.length
      ? request.messages
      : [{ role: 'user', content: '(Start the conversation with a simple opening line. No correction is needed.)' }];

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(request),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages,
    });

    if (response.stop_reason === 'refusal') throw new TutorError('The tutor declined that message.', 422);
    if (response.stop_reason === 'max_tokens') throw new TutorError('The tutor reply was cut off. Please try again.', 502);
    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new TutorError('The tutor returned no reply.', 502);
    return JSON.parse(text);
  };
}

export function validateGenerateRequest(body) {
  const { lang, prompt } = body ?? {};
  if (!/^[a-z]{2,8}$/.test(lang ?? '') || typeof prompt !== 'string' || !prompt.length || prompt.length > MAX_PROMPT_CHARS) return null;
  return { lang, prompt };
}

// Writes new exercises from the same prompt a learner can paste into a chat app. The reply is checked by the client.
export function createGenerator(client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null) {
  if (!client) return null;
  return async function generate({ prompt }) {
    const response = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'You write language-learning exercises for a practice app. Follow the rules in the request exactly; the app rejects items that break them.',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: UPDATE_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }).finalMessage();

    if (response.stop_reason === 'refusal') throw new TutorError('The model declined to write exercises.', 422);
    if (response.stop_reason === 'max_tokens') throw new TutorError('The reply was cut off. Please try again.', 502);
    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new TutorError('The model returned no exercises.', 502);
    return { text };
  };
}

export class TutorError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function tutorErrorResponse(error) {
  if (error instanceof TutorError) return { status: error.status, message: error.message };
  if (error instanceof Anthropic.AuthenticationError) return { status: 502, message: 'The server API key was rejected.' };
  if (error instanceof Anthropic.RateLimitError) return { status: 429, message: 'The tutor is rate limited. Try again shortly.' };
  if (error instanceof Anthropic.APIError) return { status: 502, message: 'The tutor service had an error.' };
  return { status: 500, message: 'The tutor failed unexpectedly.' };
}
