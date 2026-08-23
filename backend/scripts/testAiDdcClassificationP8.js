import assert from 'assert';
import { recommendDdc } from '../src/services/ddcClassificationService.js';
import { buildDdcAnalysisPrompt, parseAiDdcResponse } from '../src/services/ddcAiClassifier.js';
import { generateMarcRecord } from '../src/services/marcPipeline.js';

const wutheringHeights = {
  title: 'Wuthering Heights',
  authors: ['Emily Brontë'],
  publisher: 'Penguin Classics',
  publish_date: '2003',
  language: 'eng',
  description: "Emily Brontë's only novel, first published in 1847. Includes bibliographical references and index.",
  subjects: ['Gothic fiction', 'Yorkshire (England) -- Fiction'],
};

function aiResponse(obj) {
  return { model: 'fake-test-model', text: JSON.stringify(obj) };
}

// ---------------------------------------------------------------------
// No AI provider configured (this sandbox has no OPENAI_API_KEY/
// NVIDIA_API_KEY) -- must fall back to the real, evidence-grounded
// rule-based engine, never a fake/empty result.
// ---------------------------------------------------------------------
let decision = await recommendDdc(wutheringHeights);
assert.strictEqual(decision.recommended_ddc.number, '823.8');
assert.strictEqual(decision.classification_source, 'RULE_BASED');
assert.strictEqual(decision.ai_attempted, false);
assert.strictEqual(decision.edition, 'DDC 23');
assert.ok(decision.class_name);
assert.ok(decision.why);
assert.ok(Array.isArray(decision.sources) && decision.sources.length > 0);

// ---------------------------------------------------------------------
// AI available and returns a valid, well-grounded answer -- used as the
// primary recommendation, with the full structured shape the product spec
// requires (ddc/class_name/work_type/confidence/why/number_breakdown/
// evidence/sources), and never a bare string.
// ---------------------------------------------------------------------
let calls = 0;
decision = await recommendDdc(wutheringHeights, {
  classifyWithAiFn: async () => {
    calls += 1;
    const parsed = parseAiDdcResponse(
      aiResponse({
        ddc: '823.8',
        class_name: 'English fiction',
        work_type: 'Novel',
        confidence: 'HIGH',
        why: 'A 19th-century English novel by Emily Brontë, first published 1847 -- Victorian period.',
        number_breakdown: [
          { number: '800', meaning: 'Literature' },
          { number: '820', meaning: 'English literature' },
          { number: '823', meaning: 'English fiction' },
          { number: '823.8', meaning: 'Victorian period' },
        ],
        evidence: ['Novel by Emily Brontë', 'First published 1847'],
        sources: ['AI whole-book analysis'],
      }).text
    );
    return { ...parsed, model: 'fake-test-model', provider: 'openai' };
  },
});
assert.strictEqual(calls, 1);
assert.strictEqual(decision.recommended_ddc.number, '823.8');
assert.strictEqual(decision.classification_source, 'AI_ANALYZED');
assert.strictEqual(decision.ai_attempted, true);
assert.strictEqual(decision.ai_model, 'fake-test-model');
assert.strictEqual(decision.number_breakdown.length, 4);
assert.strictEqual(decision.number_breakdown[3].number, '823.8');

// ---------------------------------------------------------------------
// THE reported failure mode, reproduced against the AI path itself: the
// model hallucinates 025 for a novel on its first attempt. This must be
// rejected (never shown to the librarian), retried with an explicit
// correction, and the corrected attempt used.
// ---------------------------------------------------------------------
calls = 0;
decision = await recommendDdc(wutheringHeights, {
  classifyWithAiFn: async ({ correction }) => {
    calls += 1;
    if (calls === 1) {
      assert.strictEqual(correction, null, 'first attempt must not carry a correction');
      const parsed = parseAiDdcResponse(aiResponse({ ddc: '025', class_name: 'Library operations', work_type: 'Novel', confidence: 'MEDIUM', why: 'wrong', number_breakdown: [], evidence: [], sources: [] }).text);
      return { ...parsed, model: 'fake-test-model', provider: 'openai' };
    }
    assert.ok(correction && correction.number === '025', 'retry must carry the rejected number as a correction');
    const parsed = parseAiDdcResponse(
      aiResponse({ ddc: '823.8', class_name: 'English fiction', work_type: 'Novel', confidence: 'HIGH', why: 'corrected', number_breakdown: [{ number: '823.8', meaning: 'Victorian period' }], evidence: [], sources: [] }).text
    );
    return { ...parsed, model: 'fake-test-model', provider: 'openai' };
  },
});
assert.strictEqual(calls, 2, 'must retry exactly once after a rejected first attempt');
assert.strictEqual(decision.recommended_ddc.number, '823.8');
assert.notStrictEqual(decision.recommended_ddc.number, '025');
assert.strictEqual(decision.classification_source, 'AI_ANALYZED');
assert.strictEqual(decision.ai_rejected, null, 'a successful retry must not still report a rejection');

// ---------------------------------------------------------------------
// AI is persistently wrong across every attempt -- must fall back to the
// rule-based (correct) answer rather than displaying the bad number or
// failing outright. "Never fake success": the librarian still gets a
// real, evidence-grounded 823.8, just honestly labeled as rule-based.
// ---------------------------------------------------------------------
calls = 0;
decision = await recommendDdc(wutheringHeights, {
  classifyWithAiFn: async () => {
    calls += 1;
    const parsed = parseAiDdcResponse(aiResponse({ ddc: '025', class_name: 'Library operations', work_type: 'Novel', confidence: 'MEDIUM', why: 'still wrong', number_breakdown: [], evidence: [], sources: [] }).text);
    return { ...parsed, model: 'fake-test-model', provider: 'openai' };
  },
});
assert.strictEqual(calls, 2, 'must stop retrying after the attempt limit');
assert.strictEqual(decision.recommended_ddc.number, '823.8', 'must fall back to the correct rule-based number, never display 025');
assert.strictEqual(decision.classification_source, 'RULE_BASED');
assert.strictEqual(decision.ai_attempted, true);
assert.ok(decision.ai_rejected && decision.ai_rejected.number === '025');

// ---------------------------------------------------------------------
// AI proposes a bare main class (universally invalid, not just for
// literary works) -- also rejected.
// ---------------------------------------------------------------------
decision = await recommendDdc(
  { title: 'A Book About Business', description: 'Corporate planning, leadership, organization, and general management practices.' },
  {
    classifyWithAiFn: async () => {
      const parsed = parseAiDdcResponse(aiResponse({ ddc: '600', class_name: 'Technology', work_type: 'Monograph', confidence: 'LOW', why: 'too broad', number_breakdown: [], evidence: [], sources: [] }).text);
      return { ...parsed, model: 'fake-test-model', provider: 'openai' };
    },
  }
);
assert.notStrictEqual(decision.recommended_ddc.number, '600');
assert.ok(!/^\d00$/.test(decision.recommended_ddc.number));

// ---------------------------------------------------------------------
// AI proposes a number that isn't even in AutoCat's DDC 23 reference --
// rejected as unverifiable, not trusted on the model's word alone.
// ---------------------------------------------------------------------
decision = await recommendDdc(wutheringHeights, {
  classifyWithAiFn: async () => {
    const parsed = parseAiDdcResponse(aiResponse({ ddc: '823.87654', class_name: 'Invented', work_type: 'Novel', confidence: 'HIGH', why: 'fabricated precision', number_breakdown: [], evidence: [], sources: [] }).text);
    return { ...parsed, model: 'fake-test-model', provider: 'openai' };
  },
});
assert.notStrictEqual(decision.recommended_ddc.number, '823.87654');

// ---------------------------------------------------------------------
// Malformed AI output (unparseable JSON) must not crash the request --
// treated as a failed attempt, falls back to the rule-based result.
// ---------------------------------------------------------------------
decision = await recommendDdc(wutheringHeights, {
  classifyWithAiFn: async () => {
    throw new Error('could not parse AI response as JSON: Unexpected token');
  },
});
assert.strictEqual(decision.recommended_ddc.number, '823.8');
assert.strictEqual(decision.classification_source, 'RULE_BASED');
assert.strictEqual(decision.ai_attempted, true);

// ---------------------------------------------------------------------
// Prompt content: DDC 23 explicitly required, other editions/systems
// explicitly excluded, full bibliographic evidence included (not just
// title), and a correction is folded in when retrying.
// ---------------------------------------------------------------------
let prompt = buildDdcAnalysisPrompt(wutheringHeights, [{ term: 'English fiction', ddc_number: '823', qualifier: null }]);
assert.ok(/DDC 23/.test(prompt));
assert.ok(/DDC 22/.test(prompt) && /Library of Congress/i.test(prompt), 'must explicitly exclude other editions/systems');
assert.ok(prompt.includes('Emily Bront') && prompt.includes('first published in 1847'), 'must include full bibliographic evidence, not just the title');
assert.ok(prompt.includes('823'), 'must include grounding candidates from the DDC relative index');

prompt = buildDdcAnalysisPrompt(wutheringHeights, [], { number: '025', reason: 'contradicts the identified literary nature of the work' });
assert.ok(prompt.includes('was rejected') && prompt.includes('025'));

// ---------------------------------------------------------------------
// MARC 082$a integration: the approved AI-driven result populates 082,
// exactly like the rule-based path -- the extension never recalculates.
// ---------------------------------------------------------------------
decision = await recommendDdc(wutheringHeights, {
  classifyWithAiFn: async () => {
    const parsed = parseAiDdcResponse(aiResponse({ ddc: '823.8', class_name: 'English fiction', work_type: 'Novel', confidence: 'HIGH', why: 'ok', number_breakdown: [], evidence: [], sources: [] }).text);
    return { ...parsed, model: 'fake-test-model', provider: 'openai' };
  },
});
const ddcApproval = { approval_status: 'APPROVED', approved_ddc: decision.recommended_ddc.number };
const marc = generateMarcRecord({ metadata: wutheringHeights, ddc_approval: ddcApproval });
const line082 = marc.preview.find((r) => r.tag === '082');
// $b is the Cutter mark: first three capital letters of the primary
// author's surname (product spec item 29/33) -- wutheringHeights's author
// is Emily Bronte.
assert.strictEqual(line082.value, '$a 823.8 $b BRO $2 23');
assert.strictEqual(marc.validation.valid, true);

console.log('P8 AI-driven DDC classification tests passed');
