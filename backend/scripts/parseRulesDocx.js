import mammoth from 'mammoth';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rulesDir = join(__dirname, '..', 'rules');

const docxFilename = 'MARC_Cataloguing_Reference_Manual (1).docx';
const docxPath = join(rulesDir, docxFilename);

const MARC_TAG_HEADING =
  /^(?:#{1,6}\s*)?(\d{3}(?:\/\d{3})?)\s*[-–—]+\s*(.+)$/;

function isMarcTagHeading(line) {
  const trimmed = line.trim();
  const match = trimmed.match(MARC_TAG_HEADING);
  if (!match) {
    return null;
  }

  const fieldName = match[2].trim();
  if (!/[A-Za-z]/.test(fieldName)) {
    return null;
  }

  return { tag: match[1], fieldName, line: trimmed };
}

function stripMarkdownEscapes(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
}

function extractSharedSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];

  const sharedDefinitions = [
    {
      title: 'ISBD punctuation master rules',
      startPattern: /^#\s*2\.\s*ISBD Prescribed Punctuation/i,
      endPattern: /^#\s*3\.\s*Statement of Responsibility/i,
    },
    {
      title: 'Statement of responsibility (245$c) scenarios',
      startPattern: /^#\s*3\.\s*Statement of Responsibility/i,
      endPattern: /^#\s*4\.\s*Field-by-Field Cataloguing Rules/i,
    },
    {
      title: 'AACR2 main/added entry choice rules',
      startPattern: /^#\s*5\.\s*Choice and Form of Main\/Added Entry/i,
      endPattern: /^#\s*6\.\s*Final Quality-Control Checklist/i,
    },
  ];

  for (const def of sharedDefinitions) {
    let startIdx = -1;
    let endIdx = lines.length;

    for (let i = 0; i < lines.length; i++) {
      const normalized = stripMarkdownEscapes(lines[i].trim());
      if (startIdx === -1 && def.startPattern.test(normalized)) {
        startIdx = i;
        continue;
      }
      if (startIdx !== -1 && def.endPattern.test(normalized)) {
        endIdx = i;
        break;
      }
    }

    if (startIdx === -1) {
      console.warn(`Warning: shared section not found: ${def.title}`);
      continue;
    }

    sections.push({
      title: def.title,
      content_markdown: lines.slice(startIdx, endIdx).join('\n').trim(),
    });
  }

  return sections;
}

function isSectionGroupHeading(line) {
  const trimmed = line.trim();
  return /^##\s+\d+\.\d+/.test(stripMarkdownEscapes(trimmed)) && !isMarcTagHeading(line);
}

function extractMarcFieldSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];

  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const heading = isMarcTagHeading(lines[i]);

    if (heading) {
      if (current) {
        current.content_markdown = current.lines.join('\n').trim();
        delete current.lines;
        sections.push(current);
      }

      current = {
        tag: heading.tag,
        field_name: stripMarkdownEscapes(heading.fieldName),
        lines: [lines[i]],
      };
      continue;
    }

    if (current) {
      if (isSectionGroupHeading(lines[i])) {
        current.content_markdown = current.lines.join('\n').trim();
        delete current.lines;
        sections.push(current);
        current = null;
        continue;
      }

      current.lines.push(lines[i]);
    }
  }

  if (current) {
    current.content_markdown = current.lines.join('\n').trim();
    delete current.lines;
    sections.push(current);
  }

  return sections;
}

function inferRuleProfileMetadata(markdown) {
  const plain = stripMarkdownEscapes(markdown);

  const cataloguingStandard =
    'AACR2 (2nd ed.) + ISBD Consolidated Edition (2011, with 2021 Update) + MARC 21 Bibliographic';

  const ddcEditions = new Set();
  for (const match of plain.matchAll(/\b(\d{1,2}(?:st|nd|rd|th))\s+DDC\b/gi)) {
    ddcEditions.add(match[1]);
  }
  for (const match of plain.matchAll(/\be\.g\.\s*(\d{1,2}(?:st|nd|rd|th))\b/gi)) {
    if (/082|DDC|Dewey/i.test(plain.slice(Math.max(0, match.index - 200), match.index + 200))) {
      ddcEditions.add(match[1]);
    }
  }

  const notes = [];
  if (ddcEditions.size > 1) {
    notes.push(
      `Manual mentions multiple DDC editions (${[...ddcEditions].join(', ')}); confirm which edition is current before setting ddc_edition_default.`
    );
  } else if (ddcEditions.size === 0) {
    notes.push(
      'No explicit default DDC edition found in the manual; set ddc_edition_default after confirming local practice.'
    );
  }

  const ddcEditionDefault =
    ddcEditions.size === 1 ? `${[...ddcEditions][0]} (from manual)` : null;

  return {
    cataloguing_standard: cataloguingStandard,
    ddc_edition_default: ddcEditionDefault,
    ils: 'Koha',
    notes: notes.length > 0 ? notes.join(' ') : undefined,
  };
}

async function main() {
  const buffer = readFileSync(docxPath);
  const { value: markdown } = await mammoth.convertToMarkdown({ buffer });

  const sharedSections = extractSharedSections(markdown);
  const marcFieldSections = extractMarcFieldSections(markdown);
  const metadata = inferRuleProfileMetadata(markdown);

  const sharedDir = join(rulesDir, 'shared');
  mkdirSync(sharedDir, { recursive: true });

  const marcFieldRulesPath = join(rulesDir, 'marc_field_rules.json');
  const sharedRulesPath = join(sharedDir, 'isbd_and_entry_rules.json');
  const ruleProfilePath = join(rulesDir, 'rule_profile.json');

  writeFileSync(marcFieldRulesPath, `${JSON.stringify(marcFieldSections, null, 2)}\n`);
  writeFileSync(sharedRulesPath, `${JSON.stringify(sharedSections, null, 2)}\n`);

  const ruleProfile = {
    cataloguing_standard: metadata.cataloguing_standard,
    ddc_edition_default: metadata.ddc_edition_default,
    ils: metadata.ils,
    knowledge_base_files: ['marc_field_rules.json', 'shared/isbd_and_entry_rules.json'],
  };

  if (metadata.notes) {
    ruleProfile.notes = metadata.notes;
  }

  writeFileSync(ruleProfilePath, `${JSON.stringify(ruleProfile, null, 2)}\n`);

  const tags = marcFieldSections.map((section) => section.tag);

  console.log('=== AutoCat rules parsing summary ===');
  console.log(`Source: ${docxFilename}`);
  console.log(`Tag-specific sections: ${marcFieldSections.length}`);
  console.log(`Shared sections: ${sharedSections.length}`);
  console.log(`Tags found (${tags.length}): ${tags.join(', ')}`);
  console.log('');
  console.log('Shared section titles:');
  for (const section of sharedSections) {
    console.log(`  - ${section.title} (${section.content_markdown.length} chars)`);
  }
  console.log('');
  console.log('Output files:');
  console.log(`  ${marcFieldRulesPath}`);
  console.log(`  ${sharedRulesPath}`);
  console.log(`  ${ruleProfilePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
