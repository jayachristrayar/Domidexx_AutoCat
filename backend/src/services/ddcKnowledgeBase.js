import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.join(__dirname, '..', '..', 'rules');
const DDC_SOURCE = 'project_supplied_ddc_reference';

export const MAIN_CLASSES = {
  '000': 'Computer science, information & general works',
  '100': 'Philosophy & psychology',
  '200': 'Religion',
  '300': 'Social sciences',
  '400': 'Language',
  '500': 'Natural sciences & mathematics',
  '600': 'Technology',
  '700': 'The arts; fine & decorative arts',
  '800': 'Literature & rhetoric',
  '900': 'History & geography',
};
function readJson(name) { return JSON.parse(fs.readFileSync(path.join(rulesDir, name), 'utf8')); }
export function normalizeDdcNumber(number) { return String(number ?? '').trim(); }
export function getMainClass(number) { const n = normalizeDdcNumber(number); const v = Number(n.slice(0, 3)); return `${Math.floor(v / 100) * 100}`.padStart(3, '0'); }
export function getParentNumber(number) { const n = normalizeDdcNumber(number); if (!n || MAIN_CLASSES[n]) return null; if (n.includes('.')) return n.split('.')[0]; const v = Number(n); if (v % 10 !== 0) return `${Math.floor(v / 10) * 10}`.padStart(3, '0'); return getMainClass(n); }
export function buildPath(number) { const path = []; let cur = normalizeDdcNumber(number); const guard = new Set(); while (cur && !guard.has(cur)) { path.unshift(cur); guard.add(cur); cur = getParentNumber(cur); } return path; }
export function enrichClass(row) { const number = normalizeDdcNumber(row.number); return { ...row, number, parent_number: getParentNumber(number), main_class: getMainClass(number), level: buildPath(number).length - 1, path: buildPath(number), status: row.status || 'ASSIGNED', source: row.source || DDC_SOURCE }; }
export function loadBundledDdcClasses() { return readJson('ddc_classes.json').map(enrichClass); }
export function loadBundledDdcAliases() { return readJson('ddc_aliases.json'); }
async function getPool() { return (await import('../db/index.js')).default; }
export async function seedDdcKnowledgeBase(client = null) {
  if (!client) client = await getPool();
  const classes = loadBundledDdcClasses();
  for (const c of classes) await client.query(`INSERT INTO ddc_classes (number,label,parent_number,main_class,level,status,path,source,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now()) ON CONFLICT (number) DO UPDATE SET label=EXCLUDED.label,parent_number=EXCLUDED.parent_number,main_class=EXCLUDED.main_class,level=EXCLUDED.level,status=EXCLUDED.status,path=EXCLUDED.path,source=EXCLUDED.source,updated_at=now()`, [c.number,c.label,c.parent_number,c.main_class,c.level,c.status,JSON.stringify(c.path),c.source]);
  for (const a of loadBundledDdcAliases()) await client.query(`INSERT INTO ddc_aliases (term,ddc_number,source,weight) VALUES ($1,$2,$3,$4) ON CONFLICT (term,ddc_number,source) DO UPDATE SET weight=EXCLUDED.weight`, [a.term,a.ddc_number,a.source,a.weight]);
  return { classes: classes.length };
}
export async function getDdcClass(number) { const pool = await getPool(); const {rows}=await pool.query('SELECT * FROM ddc_classes WHERE number=$1',[normalizeDdcNumber(number)]); return rows[0] ?? null; }
export async function validateDdcNumber(number) { const c = await getDdcClass(number); return { valid: !!c && c.status === 'ASSIGNED', class: c, reason: !c ? 'NOT_FOUND' : c.status !== 'ASSIGNED' ? c.status : null }; }
export async function searchDdc(query, limit=20) { const q=String(query??'').trim(); if(!q) return []; const pool = await getPool(); const {rows}=await pool.query(`SELECT DISTINCT c.* FROM ddc_classes c LEFT JOIN ddc_aliases a ON a.ddc_number=c.number WHERE c.number ILIKE $1 OR c.label ILIKE $2 OR a.term ILIKE $2 ORDER BY c.number LIMIT $3`, [`${q}%`,`%${q}%`,limit]); return rows; }
export function findBundledClass(number) { return loadBundledDdcClasses().find(c => c.number === normalizeDdcNumber(number)); }
