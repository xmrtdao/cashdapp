
/**
 * ef:suite-doc-export
 * Professional DOCX export for audited documents.
 * Uses python-docx via bridge to generate an attributed legal report.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export async function handler(payload) {
  const { text, audit, fileName = 'audit_report.docx' } = payload;

  if (!text || !audit) {
    throw new Error('Missing text or audit data for export');
  }

  try {
    // We will create a temporary JSON file containing the audit data 
    // and the final text to be passed to a Python helper script.
    const tempInputPath = path.join('/tmp', `export_${Date.now()}.json`);
    const exportData = {
      text: text,
      audit: audit,
      fileName: fileName
    };
    
    fs.writeFileSync(tempInputPath, JSON.stringify(exportData));

    // Call a Python bridge script that uses python-docx
    // (We'll create the python script in the next step)
    const cmd = `python3 "C:\\Users\\PureTrek\\Desktop\\xmrtdao\\relay\\scripts\\suite_export_docx.py" "${tempInputPath}"`;
    const outputBase64 = execSync(cmd, { encoding: 'utf8' });
    
    // The Python script will return the base64 encoded DOCX bytes.
    return {
      success: true,
      fileBase64: outputBase64.trim(),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: fileName
    };
  } catch (error) {
    console.error('Export Error:', error);
    return { success: false, error: error.message };
  }
}
