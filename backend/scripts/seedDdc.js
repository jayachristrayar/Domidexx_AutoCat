import 'dotenv/config';
import { ensureSchema } from '../src/db/index.js';
import { seedDdcKnowledgeBase } from '../src/services/ddcKnowledgeBase.js';
await ensureSchema();
const result = await seedDdcKnowledgeBase();
console.log(`Seeded DDC knowledge base (${result.classes} classes).`);
process.exit(0);
