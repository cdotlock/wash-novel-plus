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
    content: z.string().min(1),  // Allow shorter content when chapters are pre-parsed
    name: z.string().optional(),
    // Optional: pre-parsed chapters (skips auto-parsing when provided)
    chapters: z.array(z.object({
        number: z.number(),
        title: z.string(),
        content: z.string(),
    })).optional(),
});


// Chapter parsing patterns - Enhanced for bilingual support
const CHAPTER_PATTERNS = {
    // Chinese patterns
    cnChapter: /第(?<num>[一二三四五六七八九十百千零〇\d]+)[章节回][\s\.:：]*(?<title>[^\n]*)/g,
    cnVolume: /(?:第(?<num>[一二三四五六七八九十百千零〇\d]+)[卷部篇]|卷(?<num2>[一二三四五六七八九十百千\d]+))[\s\.:：]*(?<title>[^\n]*)/g,
    cnSpecial: /(?<type>序章|序言|前言|楔子|终章|尾声|番外|后记)[\s\.:：]*(?<title>[^\n]*)/g,

    // English patterns
    enChapter: /(?:Chapter|CHAPTER)\s+(?<num>\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty(?:\s*[-–—]\s*(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine))?)[\.:\s\-–—]*(?<title>[^\n]*)/gi,
    enPart: /(?:Part|PART|Book|BOOK|Section|SECTION)\s+(?<num>\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)[\.:\s\-–—]*(?<title>[^\n]*)/gi,
    enSpecial: /(?<type>Prologue|PROLOGUE|Epilogue|EPILOGUE|Introduction|INTRODUCTION|Preface|PREFACE|Afterword|AFTERWORD)[\.:\s\-–—]*(?<title>[^\n]*)/gi,
    enNumbered: /^(?<num>\d{1,4})[\s\.\-:|\)]+(?<title>[A-Z][^\n]*)/gm,
};

// Word to number mapping for English
const WORD_TO_NUMBER: Record<string, number> = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
    'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
    'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24,
    'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27, 'twenty-eight': 28, 'twenty-nine': 29,
};

// Roman numeral conversion
function romanToNumber(roman: string): number {
    const romanMap: Record<string, number> = {
        'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100, 'D': 500, 'M': 1000
    };
    let result = 0;
    const upper = roman.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
        const current = romanMap[upper[i]] || 0;
        const next = romanMap[upper[i + 1]] || 0;
        if (current < next) {
            result -= current;
        } else {
            result += current;
        }
    }
    return result;
}

// Convert Chinese number to integer
function chineseToNumber(str: string): number {
    const numMap: Record<string, number> = {
        '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4,
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

// Parse number from string (Chinese, English word, Roman, or digit)
function parseChapterNumber(numStr: string, fallback: number): number {
    if (!numStr) return fallback;

    const cleaned = numStr.trim().toLowerCase();

    // Check direct digit
    if (/^\d+$/.test(cleaned)) {
        return parseInt(cleaned, 10);
    }

    // Check English word number
    const wordNum = WORD_TO_NUMBER[cleaned] || WORD_TO_NUMBER[cleaned.replace(/\s+/g, '-')];
    if (wordNum) return wordNum;

    // Check Roman numeral
    if (/^[IVXLCDM]+$/i.test(numStr)) {
        return romanToNumber(numStr);
    }

    // Check Chinese number
    return chineseToNumber(numStr) || fallback;
}

// Special chapter type to number (for ordering)
const SPECIAL_ORDER: Record<string, number> = {
    '序章': -3, '序言': -3, '前言': -2, '楔子': -1,
    'prologue': -3, 'preface': -2, 'introduction': -1,
    '终章': 9999, '尾声': 9998, '番外': 9997, '后记': 9996,
    'epilogue': 9999, 'afterword': 9998,
};

interface PatternMatch {
    index: number;
    length: number;
    number: number;
    title: string;
    isSpecial: boolean;
}

// Find all matches for a specific pattern
function findPatternMatches(text: string, pattern: RegExp, isChinese: boolean): PatternMatch[] {
    const matches: PatternMatch[] = [];
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;

    while ((match = regex.exec(text)) !== null) {
        const numStr = match.groups?.num || match.groups?.num2 || '';
        const typeStr = match.groups?.type || '';
        const title = (match.groups?.title || '').trim();

        let number: number;
        let isSpecial = false;

        if (typeStr) {
            // Special chapter (prologue, epilogue, etc.)
            const typeLower = typeStr.toLowerCase();
            number = SPECIAL_ORDER[typeLower] ?? SPECIAL_ORDER[typeStr] ?? matches.length + 1;
            isSpecial = true;
        } else {
            number = parseChapterNumber(numStr, matches.length + 1);
        }

        matches.push({
            index: match.index,
            length: match[0].length,
            number,
            title: title || (isSpecial ? typeStr : `Chapter ${number}`),
            isSpecial,
        });
    }

    return matches;
}

// Parse chapters from text with enhanced bilingual support
function parseChapters(text: string): Chapter[] {
    const chapters: Chapter[] = [];

    // Try all patterns and score them
    const patternResults: { name: string; matches: PatternMatch[]; score: number }[] = [];

    // Chinese patterns
    const cnChapterMatches = findPatternMatches(text, CHAPTER_PATTERNS.cnChapter, true);
    const cnVolumeMatches = findPatternMatches(text, CHAPTER_PATTERNS.cnVolume, true);
    const cnSpecialMatches = findPatternMatches(text, CHAPTER_PATTERNS.cnSpecial, true);

    // English patterns
    const enChapterMatches = findPatternMatches(text, CHAPTER_PATTERNS.enChapter, false);
    const enPartMatches = findPatternMatches(text, CHAPTER_PATTERNS.enPart, false);
    const enSpecialMatches = findPatternMatches(text, CHAPTER_PATTERNS.enSpecial, false);
    const enNumberedMatches = findPatternMatches(text, CHAPTER_PATTERNS.enNumbered, false);

    // Score patterns (more matches + better coverage = higher score)
    const scorePattern = (matches: PatternMatch[]) => {
        if (matches.length === 0) return 0;
        // Base score from count
        let score = matches.length * 10;
        // Bonus for sequential numbering
        const numbers = matches.filter(m => !m.isSpecial).map(m => m.number).sort((a, b) => a - b);
        let sequential = 0;
        for (let i = 1; i < numbers.length; i++) {
            if (numbers[i] === numbers[i - 1] + 1) sequential++;
        }
        score += sequential * 5;
        return score;
    };

    patternResults.push({ name: 'cnChapter', matches: cnChapterMatches, score: scorePattern(cnChapterMatches) });
    patternResults.push({ name: 'enChapter', matches: enChapterMatches, score: scorePattern(enChapterMatches) });
    patternResults.push({ name: 'enNumbered', matches: enNumberedMatches, score: scorePattern(enNumberedMatches) });

    // Find best primary pattern
    patternResults.sort((a, b) => b.score - a.score);
    const best = patternResults[0];

    if (best.score === 0) {
        // No patterns found - treat as single chapter
        return [{
            number: 1,
            title: 'Chapter 1',
            content: text.trim(),
        }];
    }

    // Combine best pattern with special chapters and volumes
    let allMatches: PatternMatch[] = [...best.matches];

    // Add special chapters (prologue, epilogue, etc.)
    const specialMatches = best.name.startsWith('cn') ? cnSpecialMatches : enSpecialMatches;
    for (const special of specialMatches) {
        // Only add if not overlapping with existing matches
        const overlaps = allMatches.some(m =>
            Math.abs(m.index - special.index) < 50
        );
        if (!overlaps) {
            allMatches.push(special);
        }
    }

    // Sort all matches by position in text
    allMatches.sort((a, b) => a.index - b.index);

    // Extract chapter content
    for (let i = 0; i < allMatches.length; i++) {
        const match = allMatches[i];
        const nextMatch = allMatches[i + 1];

        const startIndex = match.index + match.length;
        const endIndex = nextMatch?.index ?? text.length;
        const content = text.slice(startIndex, endIndex).trim();

        if (content.length > 0) {
            // Normalize special chapter numbers to be at beginning or end
            let number = match.number;
            if (match.isSpecial && number < 0) {
                // Keep negative for sorting, will renumber later
            } else if (match.isSpecial && number > 9000) {
                // Keep high number for sorting
            }

            chapters.push({
                number,
                title: match.title,
                content,
            });
        }
    }

    // Renumber chapters sequentially, keeping special chapters at start/end
    const specials = chapters.filter(c => c.number < 0 || c.number > 9000);
    const regulars = chapters.filter(c => c.number >= 0 && c.number <= 9000);

    // Sort regulars by their detected number
    regulars.sort((a, b) => a.number - b.number);

    // Renumber regulars from 1
    regulars.forEach((c, i) => { c.number = i + 1; });

    // Handle specials at start
    const startSpecials = specials.filter(c => c.number < 0).sort((a, b) => a.number - b.number);
    startSpecials.forEach((c, i) => { c.number = -(startSpecials.length - i); }); // Keep negative

    // Handle specials at end
    const endSpecials = specials.filter(c => c.number > 9000).sort((a, b) => a.number - b.number);
    const lastRegular = regulars.length > 0 ? regulars[regulars.length - 1].number : 0;
    endSpecials.forEach((c, i) => { c.number = lastRegular + i + 1; });

    // Combine and sort by position (already in correct order from original parsing)
    return chapters;
}

// Detect primary language of content
function detectLanguage(text: string): 'cn' | 'en' | 'mixed' {
    const sample = text.slice(0, 10000);
    const chineseChars = (sample.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (sample.match(/[a-zA-Z]+/g) || []).length;

    const chineseRatio = chineseChars / sample.length;
    const englishRatio = englishWords / (sample.split(/\s+/).length || 1);

    if (chineseRatio > 0.3 && englishRatio > 0.3) return 'mixed';
    if (chineseRatio > 0.2) return 'cn';
    return 'en';
}

// Preview request schema (no session required)
const PreviewRequestSchema = z.object({
    content: z.string().min(100),
});

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
    // Preview chapter split (no database changes)
    app.post('/api/preview-split', async (request) => {
        const body = PreviewRequestSchema.parse(request.body);

        // Parse chapters
        const chapters = parseChapters(body.content);
        const detectedLanguage = detectLanguage(body.content);
        const totalChars = chapters.reduce((sum, c) => sum + c.content.length, 0);

        return {
            success: true,
            chapterCount: chapters.length,
            detectedLanguage,
            totalChars,
            chapters: chapters.map((c) => ({
                number: c.number,
                title: c.title,
                contentLength: c.content.length,
                contentPreview: c.content.slice(0, 2000), // First 2000 chars for preview
            })),
        };
    });

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

            // Use pre-parsed chapters if provided, otherwise auto-parse from content
            let chapters: Chapter[];
            if (body.chapters && body.chapters.length > 0) {
                // Trust provided chapter structure (skip auto-parsing)
                chapters = body.chapters;
            } else {
                // Auto-parse chapters from raw content
                chapters = parseChapters(body.content);
            }

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

    // Direct chapter upload (skip auto-parsing, for multi-file uploads)
    // When frontend uploads multiple files, each file IS a chapter - no parsing needed
    const DirectChaptersSchema = z.object({
        chapters: z.array(z.object({
            number: z.number(),
            title: z.string(),
            content: z.string(),
        })),
        name: z.string().optional(),
    });

    app.post<{ Params: { id: string } }>(
        '/api/sessions/:id/upload-chapters',
        async (request, reply) => {
            const { id } = request.params;
            const body = DirectChaptersSchema.parse(request.body);

            // Check session exists
            const session = await prisma.session.findUnique({
                where: { id },
            });

            if (!session) {
                return reply.status(404).send({ error: 'Session not found' });
            }

            if (body.chapters.length === 0) {
                return reply.status(400).send({ error: 'No chapters provided' });
            }

            // Check for duplicate chapter numbers
            const seenNumbers = new Set<number>();
            const duplicates: number[] = [];
            for (const chapter of body.chapters) {
                if (seenNumbers.has(chapter.number)) {
                    duplicates.push(chapter.number);
                }
                seenNumbers.add(chapter.number);
            }
            if (duplicates.length > 0) {
                request.log.warn({ duplicates, sessionId: id }, 'Duplicate chapter numbers detected - later chapters will overwrite earlier ones');
            }

            // Convert to record (trust frontend structure, no re-parsing)

            const chaptersRecord: Record<string, Chapter> = {};
            for (const chapter of body.chapters) {
                chaptersRecord[chapter.number] = chapter;
            }

            // Update session
            await prisma.session.update({
                where: { id },
                data: {
                    name: body.name ?? session.name,
                    chapters: chaptersRecord,
                    status: 'indexing',
                },
            });

            return {
                success: true,
                chapterCount: body.chapters.length,
                chapters: body.chapters.map((c) => ({
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
