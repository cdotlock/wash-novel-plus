import { Langfuse } from 'langfuse';
import 'dotenv/config';
import { writeFileSync } from 'fs';
import path from 'path';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY || '',
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
});

// All prompt base names we care about for Wash 2.0
const BASE_PROMPTS = [
  'wash-indexing',
  'wash-planning-auto',
  'wash-planning-split',
  'wash-planning-merge',
  'wash-planning-adjust',
  'wash-planning-butterfly',
  'wash-generate',
  'wash-memory',
  'wash-review',
  'wash-characters',
  'wash-branch-plan',
  'wash-branch-write',
  'wash-rename-node',
];

const LANG_SUFFIXES: Array<'cn' | 'en'> = ['cn', 'en'];

async function downloadPrompts() {
  console.log('🔽 Downloading prompts from Langfuse...');

  const snapshot: Record<string, unknown> = {};

  for (const base of BASE_PROMPTS) {
    for (const lang of LANG_SUFFIXES) {
      const name = `${base}-${lang}`;
      try {
        // getPrompt 返回的对象包含 compile 等方法，这里只做 JSON 序列化
        const prompt: any = await langfuse.getPrompt(name);
        let serialized: unknown;
        try {
          serialized = JSON.parse(JSON.stringify(prompt));
        } catch {
          serialized = { warning: 'Prompt is not fully serializable, stored as empty shell', name };
        }
        snapshot[name] = serialized;
        console.log(`✅ Fetched ${name}`);
      } catch (e: any) {
        console.error(`⚠️ Failed to fetch ${name}:`, e?.message || e);
      }
    }
  }

  const outPath = path.join(process.cwd(), 'prompts_snapshot.json');
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`✨ Prompt snapshot written to ${outPath}`);
}

downloadPrompts().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error while downloading prompts:', err);
  process.exit(1);
});
