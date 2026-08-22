// Automated MARC rule consistency checker.
// Compares RULE REGISTRY × BUILDER × VALIDATOR × KOHA MAPPER × Admin surface.

import { getAllMarcRules, getSeriesPolicy, hasMarcRule, normalizeMarcTag } from './marcRuleRegistry.js';
import { getBuilderEmittedTags, getBuilderMechanicalTags } from './marcBuilder.js';
import { getValidatorCoveredTags } from './marcValidator.js';
import { getMapperTags, canMapTag } from './kohaMapper.js';
import { getPipelineEmittedTags } from './marcPipeline.js';

function yesNo(value) {
  return value ? 'YES' : 'NO';
}

function coverageLabel({ rule, builder, validator, mapper }) {
  if (!rule) return 'NO_RULE';
  if (rule.status === 'SUPPORTED') {
    if (!builder) return 'SUPPORTED_BUT_BUILDER_MISSING';
    if (!validator) return 'SUPPORTED_BUT_VALIDATOR_MISSING';
    if (!mapper && rule.field_type !== 'CONTROL_FIELD') return 'SUPPORTED_BUT_MAPPER_MISSING';
    return 'SUPPORTED';
  }
  return rule.status;
}

/**
 * @returns {{ machine: object, human: string, findings: object[] }}
 */
export function runMarcConsistencyCheck() {
  const rules = getAllMarcRules();
  const builderTags = new Set([...getBuilderEmittedTags(), ...getPipelineEmittedTags()].map(normalizeMarcTag));
  const builderMechanical = new Set([...getBuilderMechanicalTags(), ...getPipelineEmittedTags()].map(normalizeMarcTag));
  const validatorTags = new Set(getValidatorCoveredTags().map(normalizeMarcTag));
  const mapperTags = new Set(getMapperTags().map(normalizeMarcTag));

  const allTags = new Set([
    ...rules.map((r) => r.tag),
    ...builderTags,
    ...validatorTags,
    ...mapperTags,
  ]);

  const findings = [];
  const rows = [];

  for (const tag of [...allTags].sort()) {
    const rule = rules.find((r) => r.tag === tag) ?? null;
    const builder = builderTags.has(tag);
    const validator = validatorTags.has(tag) || (rule != null && rule.validation != null);
    const mapper =
      rule?.field_type === 'CONTROL_FIELD'
        ? Boolean(rule.koha_mapping?.kind === 'CONTROL_FIELD')
        : mapperTags.has(tag) || canMapTag(tag);

    if (builder && !rule) {
      findings.push({ code: 'BUILDER_WITHOUT_RULE', tag });
    }
    if (validatorTags.has(tag) && !rule) {
      findings.push({ code: 'VALIDATOR_WITHOUT_RULE', tag });
    }
    if (mapperTags.has(tag) && !rule) {
      findings.push({ code: 'MAPPER_WITHOUT_RULE', tag });
    }
    if (rule?.status === 'SUPPORTED') {
      if (!builder && !builderMechanical.has(tag)) {
        // SUPPORTED mechanical fields must be builder-emitted; AI fields may be pass-through
        if (rule.generation_method === 'mechanical') {
          findings.push({ code: 'SUPPORTED_BUT_BUILDER_MISSING', tag });
        }
      }
      if (!rule.validation) {
        findings.push({ code: 'SUPPORTED_BUT_VALIDATOR_MISSING', tag });
      }
      if (rule.field_type === 'VARIABLE_FIELD' && !canMapTag(tag)) {
        findings.push({ code: 'SUPPORTED_BUT_MAPPER_MISSING', tag });
      }
      if (rule.validation?.incomplete) {
        findings.push({ code: 'SUPPORTED_BUT_IMPLEMENTATION_INCOMPLETE', tag });
      }
    }

    const status = coverageLabel({ rule, builder, validator, mapper });
    const row = {
      tag,
      rule: yesNo(Boolean(rule)),
      builder: builder ? (builderMechanical.has(tag) || ['000', '008', '040'].includes(tag) ? 'YES' : 'PARTIAL') : 'NO',
      validator: rule?.validation?.incomplete ? 'PARTIAL' : yesNo(validator),
      mapper:
        rule?.field_type === 'CONTROL_FIELD'
          ? 'CONTROL FIELD'
          : mapper
            ? 'YES'
            : 'NO',
      status: rule?.status ?? status,
      ddc_approval: tag === '082' ? 'P2' : undefined,
      generation_method: rule?.generation_method ?? null,
      ai_assisted: rule?.ai_assisted ?? null,
      evidence_required: rule?.evidence_required ?? null,
      cataloguer_review_required: rule?.cataloguer_review_required ?? null,
      koha_supported: rule?.koha_supported ?? null,
      notes: rule?.notes ?? null,
    };
    rows.push(row);
  }

  const series_policy = getSeriesPolicy();

  const machine = {
    generated_at: new Date().toISOString(),
    series_policy,
    finding_counts: findings.reduce((acc, f) => {
      acc[f.code] = (acc[f.code] || 0) + 1;
      return acc;
    }, {}),
    findings,
    rows,
    admin_rules_ui: 'USES_REGISTRY',
  };

  const human = formatHumanReport(machine);
  return { machine, human, findings };
}

function formatHumanReport(machine) {
  const lines = ['MARC RULE CONSISTENCY REPORT', ''];
  if (machine.series_policy) {
    lines.push('SERIES POLICY');
    lines.push(`  Target framework field: ${machine.series_policy.target_framework_field}`);
    lines.push(`  Status: ${machine.series_policy.status}`);
    lines.push(`  ${machine.series_policy.notes}`);
    lines.push('');
  }

  for (const row of machine.rows) {
    lines.push(row.tag);
    lines.push(`Rule: ${row.rule}`);
    lines.push(`Builder: ${row.builder}`);
    lines.push(`Validator: ${row.validator}`);
    lines.push(`Mapper: ${row.mapper}`);
    lines.push(`Status: ${row.status}`);
    if (row.ddc_approval) lines.push(`DDC approval: ${row.ddc_approval}`);
    lines.push('');
  }

  if (machine.findings.length) {
    lines.push('FINDINGS');
    for (const f of machine.findings) {
      lines.push(`- ${f.code}: ${f.tag}`);
    }
  } else {
    lines.push('FINDINGS: none');
  }

  return lines.join('\n');
}

export function assertNoBuilderWithoutRule() {
  const emitted = getBuilderEmittedTags();
  const missing = emitted.filter((tag) => !hasMarcRule(tag));
  return { ok: missing.length === 0, missing };
}
