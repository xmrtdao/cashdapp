import { readdir, stat, readFile } from 'fs/promises';
import { join, relative } from 'path';

/**
 * Recursively list all files in a directory.
 */
export async function listFilesRecursive(dir, baseDir = dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const res = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') return [];
            return listFilesRecursive(res, baseDir);
        } else {
            const s = await stat(res);
            return {
                path: relative(baseDir, res),
                size: s.size,
                modified: s.mtime
            };
        }
    }));
    return files.flat();
}

/**
 * Search for text within files (grep-like).
 */
export async function searchFiles(dir, query, options = {}) {
    const { recursive = true, ignoreCase = true } = options;
    const files = recursive ? await listFilesRecursive(dir) : (await readdir(dir)).map(f => ({ path: f }));
    const results = [];

    const regex = new RegExp(query, ignoreCase ? 'i' : '');

    for (const file of files) {
        const fullPath = join(dir, file.path);
        try {
            const content = await readFile(fullPath, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
                if (regex.test(line)) {
                    results.push({
                        file: file.path,
                        line: index + 1,
                        content: line.trim()
                    });
                }
            });
        } catch (err) {
            // Skip binary or unreadable files
        }
        if (results.length > 50) break; // Limit results
    }
    return results;
}

/**
 * Read file content in chunks to handle arbitrary length.
 */
export async function readFileChunked(filePath, options = {}) {
    const { start = 0, length = 32768 } = options;
    const content = await readFile(filePath, 'utf8');
    return {
        content: content.slice(start, start + length),
        totalLength: content.length,
        hasMore: (start + length) < content.length,
        nextStart: start + length
    };
}
