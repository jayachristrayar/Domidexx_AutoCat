#!/usr/bin/env node
import { runMarcConsistencyCheck } from '../src/services/marcConsistency.js';

const { human, machine } = runMarcConsistencyCheck();
console.log(human);
console.log('\n--- machine summary ---');
console.log(JSON.stringify({
  finding_counts: machine.finding_counts,
  findings: machine.findings,
  admin_rules_ui: machine.admin_rules_ui,
  series_policy: machine.series_policy,
  row_count: machine.rows.length,
}, null, 2));
