// In-app script generation: idea in, normalized shot-list document out.
//
// Replaces the clipboard round-trip (copy the import prompt, paste it into a
// chat window, paste the reply back) with one call. Everything downstream
// already existed — the import prompt builder, the JSON extractor, the
// normaliser — this module just chains them around an LLM request and knows
// how to ask again when the reply does not parse.

import { buildLlmImportPrompt, extractJsonDocument, normalizeImportedShotList } from './shotListImport.js';
import { JSON_ONLY_SYSTEM } from './prompts.js';

/**
 * Generate a shot-list document from an idea/logline/script.
 *
 * `apiFetch` is injected (server proxy or static-mode client both fit), so
 * the parse/retry logic here is pure enough to unit test with a fake.
 *
 * On a parse failure the LLM gets ONE retry, shown its own reply and the
 * parser's complaint; a second failure throws with both messages. Returns
 * what normalizeImportedShotList returns (plus its warnings) — the caller
 * previews that before committing anything to the project.
 */
export async function generateShotListFromIdea({ idea, assetLibrary = [], llm = {}, apiFetch, intro = '' }) {
  const source = String(idea || '').trim();
  if (!source) throw new Error('Write the idea first — a logline, treatment or full script.');
  if (typeof apiFetch !== 'function') throw new Error('generateShotListFromIdea needs an apiFetch.');

  const ask = async (prompt) => {
    const res = await apiFetch('/api/llm/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: llm.provider,
        model: llm.model,
        prompt,
        systemPrompt: JSON_ONLY_SYSTEM
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'LLM request failed');
    if (!data.text?.trim()) throw new Error('The model returned nothing.');
    return data.text;
  };

  const importPrompt = buildLlmImportPrompt({ assetLibrary, sourceMaterial: source, intro });
  const reply = await ask(importPrompt);

  let parsed;
  try {
    parsed = extractJsonDocument(reply);
  } catch (firstError) {
    // Feed the model its own reply and the parser's complaint — models fix
    // their own JSON far more reliably than a regenerate-from-scratch does.
    const retryReply = await ask(
      `Your previous reply could not be parsed as JSON.\n`
      + `Parser error: ${firstError.message}\n\n`
      + `=== YOUR PREVIOUS REPLY ===\n${reply}\n\n`
      + `Reply again with ONLY the corrected JSON document. No prose, no code fences.`
    );
    try {
      parsed = extractJsonDocument(retryReply);
    } catch (secondError) {
      throw new Error(
        `The model could not produce parseable JSON after a retry. `
        + `First error: ${firstError.message}; retry error: ${secondError.message}`
      );
    }
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && !parsed.scenes && !parsed.shots) {
    // The JSON_ONLY_SYSTEM escape hatch: the model said why it couldn't.
    throw new Error(`The model declined: ${parsed.error}`);
  }

  // `raw` rides along so the caller can hand the untouched document to the
  // same import path a pasted reply takes; the normalized fields are for the
  // preview shown before anything commits.
  return { ...normalizeImportedShotList(parsed), raw: parsed };
}
