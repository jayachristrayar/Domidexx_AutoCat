import assert from 'assert';
import { handleChatMessage, evaluateProposedDdc } from '../src/services/chatService.js';

// Valid override -- assigned DDC number in the bundled reference.
let r = handleChatMessage({ message: 'This DDC is wrong, use 025 instead.', context: { ddc: { decision: { recommended_ddc: { number: '020', label: 'Library & information sciences' } } } } });
assert.strictEqual(r.intent, 'override_ddc');
assert.ok(r.ddc_override.valid, 'expected 025 to validate');
assert.strictEqual(r.ddc_override.number, '025');
assert.ok(Array.isArray(r.ddc_override.breakdown) && r.ddc_override.breakdown.length > 0);

// Invalid/unassigned override must never be accepted silently.
r = handleChatMessage({ message: 'I think this should be 024.' });
assert.strictEqual(r.intent, 'override_ddc');
assert.strictEqual(r.ddc_override.valid, false);
assert.ok(/024/.test(r.reply));

// Nonsense number is rejected, not fabricated into a fake class.
r = evaluateProposedDdc('999.999');
assert.strictEqual(r.valid, false);

// Wrong-book intent asks for a fresh ISBN, never silently continues.
r = handleChatMessage({ message: 'This is the wrong book.' });
assert.strictEqual(r.intent, 'wrong_book');
assert.strictEqual(r.request_relookup, true);

// Metadata correction is captured as an explicit cataloguer value, not guessed.
r = handleChatMessage({ message: "The author is wrong, it's Jane Doe." });
assert.strictEqual(r.intent, 'correct_metadata');
assert.deepStrictEqual(r.metadata_patch, { authors: ['Jane Doe'] });

// A correction with no replacement value must ask, never invent one.
r = handleChatMessage({ message: 'The author is wrong.' });
assert.strictEqual(r.intent, 'correct_metadata_needs_value');
assert.ok(!r.metadata_patch);

// Subject steering triggers reanalysis rather than silently accepting a number.
r = handleChatMessage({ message: 'This is mainly about investment.' });
assert.strictEqual(r.intent, 'subject_hint');
assert.strictEqual(r.needs_reanalysis, true);
assert.deepStrictEqual(r.metadata_patch.keywords_add, ['investment']);

// Reanalyze / regenerate.
r = handleChatMessage({ message: 'Reanalyse the book.' });
assert.strictEqual(r.needs_reanalysis, true);

// Explain, with and without an existing decision.
r = handleChatMessage({ message: 'Why did you choose this number?' });
assert.strictEqual(r.intent, 'explain');
assert.ok(/hasn't classified/.test(r.reply));

r = handleChatMessage({
  message: 'why?',
  context: { ddc: { decision: { justification: 'Because it is about libraries.', classification_path: ['000', '020'], recommended_ddc: { confidence: 'HIGH' } } } },
});
assert.ok(r.reply.includes('Because it is about libraries.'));
assert.ok(r.reply.includes('000'));
assert.ok(r.reply.includes('HIGH'));

// Unrecognized input never fabricates an action.
r = handleChatMessage({ message: 'asdkjaslkdj random text' });
assert.strictEqual(r.intent, 'unknown');
assert.ok(!r.metadata_patch && !r.ddc_override && !r.needs_reanalysis && !r.request_relookup);

console.log('P6 chat tests passed');
