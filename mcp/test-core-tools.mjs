import { listFilesRecursive, searchFiles, readFileChunked } from './fileTools.mjs';
import { resolve, join } from 'path';

async function test() {
    const root = resolve(process.cwd());
    console.log('--- Testing listFilesRecursive ---');
    const files = await listFilesRecursive(root);
    console.log(`Found ${files.length} files.`);
    console.log('First 5 files:', files.slice(0, 5));

    console.log('\n--- Testing searchFiles ---');
    const searchResults = await searchFiles(root, 'openclaw-poller', { recursive: true });
    console.log(`Found ${searchResults.length} matches for "openclaw-poller".`);
    console.log('First 2 matches:', searchResults.slice(0, 2));

    console.log('\n--- Testing readFileChunked ---');
    const pollerPath = join(root, 'suite', 'scripts', 'openclaw-poller.mjs');
    const fileResult = await readFileChunked(pollerPath, { start: 0, length: 100 });
    console.log('Read outcome:', {
        totalLength: fileResult.totalLength,
        hasMore: fileResult.hasMore,
        preview: fileResult.content.substring(0, 50) + '...'
    });
}

test().catch(console.error);
