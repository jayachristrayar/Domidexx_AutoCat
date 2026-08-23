import pool from '../db/index.js';
import { validateDdcNumber } from './ddcKnowledgeBase.js';
const AUTO_ACCEPTED_BY = 'system:auto_accepted';
// A generated DDC recommendation is AutoCat's current working
// classification the moment it exists -- there is no separate "approve"
// step in the librarian's workflow (product spec: MARC generation must
// never wait on an approval the UI has no button for). `approval_status`/
// `approved_ddc` stay on the row purely as an audit trail of what was
// accepted and when a cataloguer later overrides it via
// approveDdcDecision -- they never gate anything downstream.
export async function saveDdcDecision({userId,metadata,decision}){
  const rec=decision.recommended_ddc?.number||null;
  const autoAccept = Boolean(rec);
  const decisionToStore = autoAccept
    ? { ...decision, approval_status: 'APPROVED', approved_ddc: rec, approved_by: AUTO_ACCEPTED_BY, approved_at: new Date().toISOString(), provenance: [...(decision.provenance||[]), 'AUTO_ACCEPTED'] }
    : decision;
  const {rows}=await pool.query(
    `INSERT INTO ddc_decisions (user_id,metadata_json,decision_json,ai_recommended_ddc,approved_ddc,approval_status,approved_by,approved_at)
     VALUES ($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8) RETURNING *`,
    [userId,JSON.stringify(metadata),JSON.stringify(decisionToStore),rec,autoAccept?rec:null,autoAccept?'APPROVED':'PENDING',autoAccept?AUTO_ACCEPTED_BY:null,autoAccept?new Date():null]
  );
  return rows[0];
}
export async function getDdcDecision(id,userId){ const {rows}=await pool.query('SELECT * FROM ddc_decisions WHERE id=$1 AND ($2::int IS NULL OR user_id=$2)',[id,userId??null]); return rows[0]??null; }
export async function approveDdcDecision({id,userId,action,ddcNumber,approvedBy}){ const existing=await getDdcDecision(id,userId); if(!existing) throw new Error('DDC decision not found'); let status=action==='REJECT'?'REJECTED':'APPROVED'; let approved=null; if(status==='APPROVED'){ approved=ddcNumber||existing.ai_recommended_ddc; const validation=await validateDdcNumber(approved); if(!validation.valid) throw new Error(`Cannot approve DDC ${approved}: ${validation.reason}`); } const decision={...existing.decision_json, approval_status:status, approved_ddc:approved, ai_recommended_ddc:existing.ai_recommended_ddc, approved_by:approvedBy, approved_at:new Date().toISOString(), provenance:[...(existing.decision_json.provenance||[]),'CATALOGUER_APPROVED']}; const {rows}=await pool.query(`UPDATE ddc_decisions SET decision_json=$1::jsonb, approved_ddc=$2, approval_status=$3, approved_by=$4, approved_at=now(), updated_at=now() WHERE id=$5 RETURNING *`,[JSON.stringify(decision),approved,status,approvedBy,id]); return rows[0]; }
export function toMarc082Contract(row, edition='23'){ if(row?.approval_status!=='APPROVED'||!row.approved_ddc) return null; return { tag:'082', subfields:[{code:'a',value:row.approved_ddc},{code:'2',value:edition}], approved_ddc:row.approved_ddc, source:`ddc/${edition}` }; }
