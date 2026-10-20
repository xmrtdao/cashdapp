
/**
 * ef:suite-doc-ingest
 * High-fidelity document ingestion for the Suite Assistant.
 * Wraps the Jobby McJobberson Python parser to provide consistent 
 * text extraction for PDF, DOCX, and TXT.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const INGESTOR_SCRIPT = 'C:\\Users\\PureTrek\\Desktop\\xmrtdao\\jobby-mcjobberson\\resume_ingest.py';

export async function handler(payload) {
  const { filePath, hint } = payload;

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Missing or invalid filePath');
  }

  try {
    // Call the Python ingestor. 
    // We pass the filePath and an optional hint for the format.
    const cmd = `python3 "${INGESTOR_SCRIPT}" --path "${filePath}" ${hint ? `--hint ${hint}` : ''}`;
    const output = execSync(cmd, { encoding: 'utf8' });
    
    // The python script returns the extracted text.
    return {
      success: true,
      text: output.trim(),
      metadata: {
        path: filePath,
        size: fs.statSync(filePath).size
      }
    };
  } catch (error) {
    console.error('Ingest Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
