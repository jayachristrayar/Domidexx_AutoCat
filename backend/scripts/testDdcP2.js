import assert from 'assert';
import { loadBundledDdcClasses, findBundledClass } from '../src/services/ddcKnowledgeBase.js';
import { analyzeWholeBookSubject } from '../src/services/wholeBookSubjectAnalyzer.js';
import { generateDdcCandidates } from '../src/services/ddcCandidateService.js';
import { recommendDdc } from '../src/services/ddcClassificationService.js';
import { validateDecision } from '../src/services/ddcJustificationService.js';

// recommendDdc is async (it may attempt an AI classification pass before
// falling back to the rule-based engine -- see ddcClassificationService.js);
// with no AI provider configured in this environment it resolves via the
// rule-based path every time, so these assertions are unaffected.
async function rec(metadata){return recommendDdc(metadata)}
const classes=loadBundledDdcClasses();
assert.ok(classes.find(c=>c.number==='000')); assert.ok(classes.find(c=>c.number==='900')); assert.ok(classes.length>=1000);
assert.strictEqual(findBundledClass('024').status,'UNASSIGNED');

let d=await rec({title:'Introduction to Library and Information Science',description:'An introductory whole-book treatment of librarianship, library services, information organization, cataloging, reference services and the functions of libraries.',table_of_contents:['The library as institution','Information organization','Reference and discovery services','Library operations']});
assert.strictEqual(d.primary_subject,'Library & Information Science'); assert.strictEqual(d.main_class.number,'000'); assert.strictEqual(d.recommended_ddc.number,'020'); assert.notStrictEqual(d.recommended_ddc.number,'650');
assert.ok(d.justification.includes('Library & Information Science')); assert.ok(d.evidence.length>=3);
assert.ok(!d.evidence.some(e=>e.type==='marc_020_isbn_as_ddc'));

assert.strictEqual((await rec({title:'Library Operations',description:'Cataloging, acquisitions, circulation, reference service, serials control, and discovery workflows.',table_of_contents:['Acquisitions','Cataloging','Circulation','Reference services']})).recommended_ddc.number,'025');
assert.strictEqual((await rec({title:'Administration of Academic Libraries',description:'Library administration, staffing, planning and management of library services.',table_of_contents:['Library planning','Staffing','Service assessment']})).primary_subject,'Library & Information Science');
assert.strictEqual((await rec({title:'Principles of Business Management',description:'Corporate planning, leadership, organization, and general management practices.'})).recommended_ddc.number,'658');
assert.strictEqual((await rec({title:'Artificial Intelligence',description:'Machine learning, neural networks, model architecture, training, inference, algorithms and deep learning.'})).recommended_ddc.number,'006.3');

d=await rec({title:'Artificial Intelligence Applications in Academic Libraries',description:'The book examines academic library services, discovery, reference, library operations, information literacy, and library management using AI as an enabling technology.',table_of_contents:['AI for reference services','Discovery in academic libraries','Library operations','Information literacy services','Managing AI-enabled library services'],keywords:['AI','Machine Learning','Python','Libraries','Automation']});
assert.strictEqual(d.primary_subject,'Library & Information Science'); assert.strictEqual(d.main_class.number,'000'); assert.notStrictEqual(d.recommended_ddc.number,'006.3'); assert.ok(d.tools_or_technologies.includes('Artificial intelligence')); assert.ok(d.justification.includes('whole-book evidence'));

assert.strictEqual((await rec({title:'Foundations of Computer Science',description:'Computing, data processing, programming, software, algorithms and systems.'})).recommended_ddc.number,'004');
assert.strictEqual((await rec({title:'Education and Curriculum Design',description:'Teaching, learning, schools, pedagogy, assessment and curriculum.'})).recommended_ddc.number,'370');
// 900 is only a bare DDC main class -- never a valid recommendation (see
// literaryDdc.validateClassificationAgainstWorkType / P7 tests). A
// multi-region survey correctly resolves to 909 (World history), DDC 23's
// own number for general/world-survey history.
assert.strictEqual((await rec({title:'World History',description:'A survey of civilizations, ancient history, Europe, Asia, Africa and America.'})).recommended_ddc.number,'909');
assert.notStrictEqual((await rec({title:'Python for Library Managers',description:'A guide to library services and library operations; Python is introduced only as a support tool.',keywords:['Python','AI']})).recommended_ddc.number,'005');
assert.strictEqual((await rec({keywords:['AI','Machine Learning','Python','Libraries','Automation'],description:'Library automation, library services and information organization are the central focus.'})).primary_subject,'Library & Information Science');
assert.strictEqual((await rec({title:'Conflicting metadata',description:'Library cataloging and reference services across the book.',subject_headings:['Artificial intelligence']})).primary_subject,'Library & Information Science');
assert.strictEqual(analyzeWholeBookSubject({keywords:['AI']}).confidence,'INSUFFICIENT');
assert.ok(!generateDdcCandidates({title:'Unassigned test'}, ['024']).candidates.find(c=>c.number==='024'));
assert.ok(!generateDdcCandidates({title:'Invalid test'}, ['999.999']).candidates.find(c=>c.number==='999.999'));
assert.deepStrictEqual(validateDecision({recommended_ddc:{number:'020'}}).valid,false);
assert.deepStrictEqual(validateDecision({recommended_ddc:{number:'020',confidence:'HIGH'},justification:'x',evidence:[1]}).valid,false);

const pending={decision_json:d,ai_recommended_ddc:'020',approval_status:'PENDING'};
const approved={...pending,approval_status:'APPROVED',approved_ddc:'020'}; assert.strictEqual(approved.approved_ddc,'020');
const changed={...pending,approval_status:'APPROVED',approved_ddc:'025'}; assert.strictEqual(changed.ai_recommended_ddc,'020'); assert.strictEqual(changed.approved_ddc,'025');
console.log('P2 DDC tests passed');
