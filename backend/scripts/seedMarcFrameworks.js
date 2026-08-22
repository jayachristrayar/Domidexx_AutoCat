import 'dotenv/config';
import { ensureSchema } from '../src/db/index.js';
import { seedMarcFrameworks } from '../src/services/marcFrameworkService.js';

await ensureSchema();
const result = await seedMarcFrameworks();
console.log(`Seeded General MARC21 vocabulary (${result.generalFields} fields) and the My Library custom framework (${result.customFields} fields).`);
process.exit(0);
