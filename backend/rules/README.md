# Cataloguing rules

Parsed cataloguing knowledge is organized as:

- `institutions/default/` — **starting template** for a rule profile (`rule_profile.json` + `marc_field_rules.json`). Copy this entire folder to `institutions/<your_slug>/` and edit `institution_id` and `institution_name` in `rule_profile.json` when onboarding a new library. Never hardcode real institution names in application code.
- `shared/` — cross-cutting rules not tied to a single MARC tag (`isbd_and_entry_rules.json`: ISBD punctuation, 245$c scenarios, AACR2 entry choice).
- Source document: `MARC_Cataloguing_Reference_Manual (1).docx` (AACR2 + ISBD + local practice).

Re-parse after updating the source document:

```bash
cd backend && npm run parse-rules
```
