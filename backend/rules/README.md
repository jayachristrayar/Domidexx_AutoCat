# Cataloguing rules

One shared cataloguing knowledge base used by every institution and user:

- `marc_runtime_rules.json` — **runtime source of truth** (status, field_type, validation, Koha mapping, generation flags). Loaded only via `src/services/marcRuleRegistry.js`.
- `rule_profile.json` — cataloguing standard metadata + `cataloguing_source` (040 config)
- `marc_field_rules.json` — cataloguing prose (`content_markdown`) attached by tag at load time
- `shared/isbd_and_entry_rules.json` — cross-cutting rules not tied to a single MARC tag
- Source document: `MARC_Cataloguing_Reference_Manual (1).docx` (AACR2 + ISBD + local practice)

Series policy: target Koha framework field is **440** (do not silently replace with 490).

Re-parse prose after updating the source document:

```bash
cd backend && npm run parse-rules
```

Consistency report:

```bash
cd backend && npm run consistency:marc
```
