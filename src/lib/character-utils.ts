/**
 * Character utilities
 * Shared functions for character name processing
 */

/**
 * Apply character map string replacement
 * For CN, we do simple global substring replacement (longest keys first).
 * For EN, we additionally try to respect word boundaries.
 */
export function applyCharacterMapStringReplace(
    content: string,
    characterMap: Record<string, string>,
    language: 'cn' | 'en'
): string {
    if (!characterMap || !Object.keys(characterMap).length) return content;

    // Sort by key length descending to handle longer names first
    const entries = Object.entries(characterMap).sort((a, b) => b[0].length - a[0].length);

    let result = content;
    for (const [oldName, newName] of entries) {
        if (!oldName || !newName) continue;
        const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = language === 'en'
            ? new RegExp(`\\b${escaped}\\b`, 'g')
            : new RegExp(escaped, 'g');
        result = result.replace(pattern, newName);
    }

    return result;
}
