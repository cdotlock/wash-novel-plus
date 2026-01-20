/**
 * Chapter utilities
 * Shared functions for chapter content processing
 */
import { Chapter } from '../schemas/session.js';
import { isCn } from './i18n.js';
import { config } from '../config/index.js';

/**
 * Build chapter content string from a range of chapters
 */
export function buildChapterContent(
    chapters: Record<string, Chapter>,
    startChapter: number,
    endChapter: number
): string {
    const blocks: string[] = [];

    for (let i = startChapter; i <= endChapter; i++) {
        const chapter = chapters[String(i)];
        if (chapter) {
            const header = isCn()
                ? `--- 第 ${chapter.number} 章: ${chapter.title} ---`
                : `--- Chapter ${chapter.number}: ${chapter.title} ---`;
            blocks.push(`${header}\n${chapter.content}`);
        }
    }

    return blocks.join('\n\n');
}

/**
 * Slice chapter content with configurable limit
 */
export function sliceChapterContent(
    content: string,
    limit: number = config.business?.chapterContentLimit ?? 6000
): string {
    return content.slice(0, limit);
}
