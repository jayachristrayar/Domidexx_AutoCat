# Cataloguing rules

One shared cataloguing knowledge base used by every institution and user:

- `rule_profile.json` — cataloguing standard metadata (`cataloguing_standard`, `ddc_edition_default`, `ils`, `knowledge_base_files`)
- `marc_field_rules.json` — MARC tag-specific rules (array of `{ tag, field_name, content_markdown }`)
- `shared/isbd_and_entry_rules.json` — cross-cutting rules not tied to a single MARC tag (ISBD punctuation, 245$c scenarios, AACR2 entry choice)
- Source document: `MARC_Cataloguing_Reference_Manual (1).docx` (AACR2 + ISBD + local practice)

Re-parse after updating the source document:

```bash
cd backend && npm run parse-rules
```
