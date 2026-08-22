const PRIORITY = ['full_text','table_of_contents','chapter_titles','purpose','preface','abstract','description','metadata_sources','subject_headings','existing_bibliographic_classification','title','subtitle','keywords','ai_generated_subjects'];
function arr(v){return Array.isArray(v)?v.filter(Boolean):v?[v]:[]}
function textOf(m){return PRIORITY.flatMap(k=>arr(m[k])).join(' ').toLowerCase()}
function evidence(m){return PRIORITY.flatMap(type=>arr(m[type]).map(value=>({type,source:m.source||'request',value:String(value).slice(0,500)})))}
function count(t, words){return words.reduce((n,w)=>n+(t.includes(w)?1:0),0)}
export function analyzeWholeBookSubject(metadata={}){
 const t=textOf(metadata), ev=evidence(metadata); if(!metadata.title&&!metadata.description&&!metadata.abstract&&arr(metadata.table_of_contents).length===0&&arr(metadata.chapter_titles).length===0) return {primary_subject:null,disciplinary_domain:null,secondary_subjects:[],related_topics:[],tools_or_technologies:[],application_areas:[],methods:[],evidence_summary:ev,confidence:'INSUFFICIENT'};
 const strong=(arr(metadata.table_of_contents).join(' ')+' '+arr(metadata.chapter_titles).join(' ')+' '+(metadata.description||'')+' '+(metadata.abstract||'')).toLowerCase();
 const library=count(strong,['library','libraries','librarian','catalog','reference service','information science','information services','circulation','acquisition','discovery']);
 const ai=count(strong,[' ai ','artificial intelligence','machine learning','neural','deep learning','algorithm','model architecture','training','inference']);
 const mgmt=count(strong,['business management','corporate','organization','leadership','general management']);
 let primary='General knowledge', domain='General works';
 if(library>=2 || /library and information science|academic libraries|library operations|library automation|information organization/.test(t)){ primary='Library & Information Science'; domain='Library & information sciences'; }
 else if(ai>=2 || /artificial intelligence|machine learning/.test(t)){ primary='Artificial Intelligence'; domain='Computer science'; }
 else if(/computer science|computing|data processing|programming/.test(t)){ primary='Computer Science'; domain='Computer science'; }
 else if(/education|teaching|pedagogy|curriculum/.test(t)){ primary='Education'; domain='Social sciences'; }
 else if(/history|civilization|ancient|europe|asia|africa|america/.test(t)){ primary='History'; domain='History & geography'; }
 else if(mgmt>=1){ primary='Business management'; domain='Management & auxiliary services'; }
 const secondary=[]; if(primary!=='Artificial Intelligence'&&ai) secondary.push('Artificial Intelligence'); if(primary!=='Library & Information Science'&&library) secondary.push('Libraries'); if(primary!=='Business management'&&mgmt) secondary.push('Management');
 const tools=[]; if(ai && primary==='Library & Information Science') tools.push('Artificial intelligence','Machine learning'); if(/python/.test(t)) tools.push('Python');
 const apps=[]; if(library && primary==='Artificial Intelligence') apps.push('Libraries');
 const confidence=ev.length>=3&&primary!=='General knowledge'?'HIGH':ev.length>=2?'MEDIUM':primary==='General knowledge'?'LOW':'MEDIUM';
 return {primary_subject:primary,disciplinary_domain:domain,secondary_subjects:secondary,related_topics:secondary,tools_or_technologies:[...new Set(tools)],application_areas:apps,methods:[],evidence_summary:ev,confidence};
}
