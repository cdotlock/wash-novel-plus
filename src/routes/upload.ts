/**
 * Upload Route
 * Handle novel text upload and chapter parsing
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { Chapter } from '../schemas/session.js';

// Request schema
const UploadRequestSchema = z.object({
    content: z.string().min(100),
    name: z.string().optional(),
});

// Chapter parsing patterns
const CHAPTER_PATTERNS = {
    cn: /第(?<num>[一二三四五六七八九十百千零\d]+)章[\s\.:：]*(?<title>[^\n]*)/g,
    enStandard: /(?:Chapter|CHAPTER)\s+(?<num>\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)[\s\.:：]*(?<title>[^\n]*)/gi,
    enNumbered: /^(?<num>\d{1,4})[\s\.\-\:|\)]+(?<title>[A-Z][^\n]*)/gm,
};

// Convert Chinese number to integer
function chineseToNumber(str: string): number {
    const numMap: Record<string, number> = {
        '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
        '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
        '十': 10, '百': 100, '千': 1000,
    };

    // If it's already a number
    if (/^\d+$/.test(str)) {
        return parseInt(str, 10);
    }

    let result = 0;
    let temp = 0;

    for (const char of str) {
        const num = numMap[char];
        if (num === undefined) continue;

        if (num >= 10) {
            if (temp === 0) temp = 1;
            result += temp * num;
            temp = 0;
        } else {
            temp = num;
        }
    }

    return result + temp;
}

// Parse chapters from text
function parseChapters(text: string): Chapter[] {
    const chapters: Chapter[] = [];

    // Detect language by sampling first 50k chars
    const sample = text.slice(0, 50000);
    const cnMatches = [...sample.matchAll(CHAPTER_PATTERNS.cn)].length;
    const enStandardMatches = [...sample.matchAll(CHAPTER_PATTERNS.enStandard)].length;
    const enNumberedMatches = [...sample.matchAll(CHAPTER_PATTERNS.enNumbered)].length;

    let pattern: RegExp;
    let isChinese = false;

    if (cnMatches >= enStandardMatches && cnMatches >= enNumberedMatches) {
        pattern = CHAPTER_PATTERNS.cn;
        isChinese = true;
    } else if (enStandardMatches >= enNumberedMatches) {
        pattern = CHAPTER_PATTERNS.enStandard;
    } else {
        pattern = CHAPTER_PATTERNS.enNumbered;
    }

    // Find all chapter markers
    const matches = [...text.matchAll(pattern)];

    if (matches.length === 0) {
        // Fallback: treat entire text as one chapter
        return [{
            number: 1,
            title: 'Chapter 1',
            content: text.trim(),
        }];
    }

    // Extract chapters
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const nextMatch = matches[i + 1];

        const startIndex = match.index! + match[0].length;
        const endIndex = nextMatch?.index ?? text.length;

        const numStr = match.groups?.num ?? String(i + 1);
        const number = isChinese ? chineseToNumber(numStr) : parseInt(numStr, 10) || (i + 1);
        const title = (match.groups?.title ?? '').trim() || `Chapter ${number}`;
        const content = text.slice(startIndex, endIndex).trim();

        if (content.length > 0) {
            chapters.push({ number, title, content });
        }
    }

    return chapters;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
    // Upload novel content
    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/upload',
        async (request, reply) => {
            const { id } = request.params;
            const body = UploadRequestSchema.parse(request.body);

            // Check session exists
            const session = await prisma.session.findUnique({
                where: { id },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            // Parse chapters
            const chapters = parseChapters(body.content);

            if (chapters.length === 0) {
                return reply.status(400).send({ error: 'No chapters found in content' });
            }

            // Convert to record
            const chaptersRecord: Record<string, Chapter> = {};
            for (const chapter of chapters) {
                chaptersRecord[chapter.number] = chapter;
            }

            // Update session
            await prisma.session.update({
                where: { id },
                data: {
                    name: body.name ?? session.name,
                    // Store as native JSON; Prisma will handle encoding
                    chapters: chaptersRecord,
                    status: 'indexing',
                },
            });

            return {
                success: true,
                chapterCount: chapters.length,
                chapters: chapters.map((c) => ({
                    number: c.number,
                    title: c.title,
                    contentLength: c.content.length,
                })),
            };
        }
    );

    // Quick upload (create session + upload in one call)
    app.post('/api/upload', async (request) => {
        const body = UploadRequestSchema.parse(request.body);

        // Parse chapters
        const chapters = parseChapters(body.content);

        // Convert to record
        const chaptersRecord: Record<string, Chapter> = {};
        for (const chapter of chapters) {
            chaptersRecord[chapter.number] = chapter;
        }

        // Create session with chapters
        const session = await prisma.session.create({
            data: {
                name: body.name ?? `Novel ${new Date().toISOString().slice(0, 10)}`,
                // Store as native JSON
                chapters: chaptersRecord,
                status: 'indexing',
            },
        });

        return {
            sessionId: session.id,
            chapterCount: chapters.length,
        };
    });
}
