import { analyzeWholeBookSubject } from './wholeBookSubjectAnalyzer.js';
import { findBundledClass, MAIN_CLASSES, buildPath } from './ddcKnowledgeBase.js';
import { classifyLiteraryWork, validateClassificationAgainstWorkType } from './literaryDdc.js';

// Non-fiction subject aliases -- matched ONLY against curated evidence text
// (see curatedEvidenceText below), never against a raw JSON dump of the
// whole metadata object. That distinction is the actual fix for the
// "Wuthering Heights classified as 025" bug: metadata frequently contains
// boilerplate catalog text like "Includes bibliographical references and
// index" (from a provider's raw notes field) or other incidental strings
// entirely unrelated to the book's subject, and JSON.stringify(metadata)
// exposed all of it -- including provenance/source blobs -- to these
// regexes. A literary work is additionally never run through this table at
// all; see generateDdcCandidates below.
const MAP = [
  [/Library & Information Science/i, '020'],
  [/library operations|catalog|circulation|reference service|acquisitions? (?:workflow|process|department)/i, '025'],
  [/library administration/i, '025.1'],
  [/Artificial Intelligence/i, '006.3'],
  [/Computer Science/i, '004'],
  [/Education/i, '370'],
  // History: never the bare 900 main class -- 909 (world history) is DDC
  // 23's own number for general/world-survey history, with region-specific
  // numbers (940 Europe, 950 Asia, 960 Africa, 970 N. America, 980 S.
  // America) scored higher in scoreCandidate when exactly one region
  // clearly dominates the evidence (see REGION_WORDS below).
  [/History/i, '909'],
  [/\beurope\b/i, '940'],
  [/\basia\b/i, '950'],
  [/\bafrica\b/i, '960'],
  [/north america/i, '970'],
  [/south america/i, '980'],
  [/Business management/i, '658'],
];

const REGION_NUMBERS = { europe: '940', asia: '950', africa: '960', 'north america': '970', 'south america': '980' };
const REGION_WORDS = Object.keys(REGION_NUMBERS);

function cls(n) {
  const c = findBundledClass(n);
  return c && c.status === 'ASSIGNED' ? c : null;
}

// Curated evidence only: the whole-book analysis's own resolved subject
// labels plus its evidence_summary values (already restricted to
// title/description/TOC/subjects/etc by wholeBookSubjectAnalyzer.js).
// Deliberately never metadata itself or JSON.stringify(metadata) -- see
// the MAP comment above.
function curatedEvidenceText(analysis) {
  return [analysis.primary_subject, analysis.disciplinary_domain, ...analysis.evidence_summary.map((e) => e.value)]
    .filter(Boolean)
    .join(' ');
}

function scoreCandidate(n, analysis, curatedText) {
  let score = 50;
  const txt = curatedText.toLowerCase();
  if (n.startsWith(analysis.main || '')) score += 10;
  if (n === '020' && analysis.primary_subject === 'Library & Information Science') score += 40;
  if (n === '020' && /introduction|introductory|overview|foundations/.test(txt)) score += 30;
  if (n === '025' && /library operations|catalog|circulation|reference service|acquisitions? (?:workflow|process|department)/.test(txt)) score += 55;
  if (n === '025.1' && /administration/.test(txt)) score += 25;
  if (n === '006.3' && analysis.primary_subject === 'Artificial Intelligence') score += 40;
  if (n === '006.3' && analysis.primary_subject === 'Library & Information Science') score -= 20;
  if (n === '658' && analysis.primary_subject !== 'Business management') score -= 35;

  // History region specificity: a single clearly-dominant region gets its
  // own regional number (940-980); a survey touching several regions (or
  // none by name) stays at 909 (world history) rather than guessing one.
  const regionsMentioned = REGION_WORDS.filter((word) => txt.includes(word));
  if (n === '909' && regionsMentioned.length !== 1) score += 45;
  if (Object.values(REGION_NUMBERS).includes(n)) {
    if (regionsMentioned.length === 1 && REGION_NUMBERS[regionsMentioned[0]] === n) score += 60;
    else score -= 40;
  }

  return score;
}

// Builds a candidate entry for a literary classification (see
// literaryDdc.js), in the same shape a bundled ddc_classes.json row would
// have, so downstream code (buildRecommendation, classPathLabels, MARC
// 082 approval) never has to special-case literary vs. non-fiction numbers.
function literaryCandidate(literary) {
  const bundled = findBundledClass(literary.number);
  return {
    number: literary.number,
    label: bundled?.label ?? literary.label,
    status: 'ASSIGNED',
    main_class: '800',
    score: 100,
    literary,
  };
}

function excludedNumbers(metadata) {
  return new Set((Array.isArray(metadata.excluded_ddc) ? metadata.excluded_ddc : []).map((n) => String(n).trim()));
}

export function generateDdcCandidates(metadata, supplied = []) {
  const analysis = analyzeWholeBookSubject(metadata);
  const excluded = excludedNumbers(metadata);

  // Content-first: is this a literary work at all? If so, its DDC number
  // comes from language + form (+ period) -- see literaryDdc.js -- and it
  // is NEVER run through the non-fiction subject-alias table below, which
  // is what previously let incidental keyword matches (e.g. "reference" in
  // boilerplate catalog notes) hijack a novel's classification.
  const literary = classifyLiteraryWork(metadata);
  if (literary && !excluded.has(literary.number)) {
    const candidate = literaryCandidate(literary);
    const validation = validateClassificationAgainstWorkType(candidate.number, literary);
    if (validation.valid) {
      return {
        analysis: {
          ...analysis,
          primary_subject: literary.label,
          disciplinary_domain: 'Literature',
          confidence: literary.confidence,
          evidence_summary: [...literary.evidence, ...analysis.evidence_summary],
          literary,
        },
        candidates: [candidate],
      };
    }
    // Should be unreachable (a literary candidate always resolves inside
    // 800 by construction), but never silently fall through to the
    // subject-alias table for an identified literary work regardless.
  }

  const curatedText = curatedEvidenceText(analysis);
  const nums = [];
  for (const [re, n] of MAP) if (re.test(curatedText)) nums.push(n);
  nums.push(...supplied);

  const unique = [...new Set(nums)].map((n) => cls(n)).filter(Boolean).filter((c) => !excluded.has(c.number));
  const ranked = unique
    .map((c) => ({ ...c, score: scoreCandidate(c.number, analysis, curatedText) }))
    // Never a bare main class (000/100/.../900) -- always require a
    // candidate more specific than that before it's even scored.
    .filter((c) => !/^\d00$/.test(c.number))
    .filter((c) => c.score > 20)
    .sort((a, b) => b.score - a.score);

  return { analysis, candidates: ranked };
}

export function buildRecommendation(metadata) {
  const { analysis, candidates } = generateDdcCandidates(metadata);

  // Validation guard (product spec: never display a number inconsistent
  // with the identified work type). Walk the ranked candidates and take
  // the first one that actually validates, rather than trusting the
  // top-scored candidate blindly.
  let rec = null;
  for (const candidate of candidates) {
    const validation = validateClassificationAgainstWorkType(candidate.number, analysis.literary ?? null);
    if (validation.valid) {
      rec = candidate;
      break;
    }
  }

  if (!rec) return { analysis, recommended: null, alternatives: [], confidence: 'INSUFFICIENT' };

  const alternatives = candidates
    .filter((c) => c.number !== rec.number)
    .slice(0, 3)
    .map((c) => ({
      number: c.number,
      label: c.label,
      reason_considered: `Matches secondary evidence or a related ${c.main_class} hierarchy.`,
      reason_rejected: `Less aligned with the whole-book primary subject (${analysis.primary_subject}) than ${rec.number}.`,
    }));

  return { analysis, recommended: rec, alternatives, confidence: analysis.confidence };
}

export function classPathLabels(number) {
  return buildPath(number).map((n) => ({ number: n, label: findBundledClass(n)?.label || MAIN_CLASSES[n] || n }));
}
