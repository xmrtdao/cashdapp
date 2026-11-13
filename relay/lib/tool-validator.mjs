// tool-validator.mjs — Pre-execution validation for shell/python/SQL tool calls.
//
// Catches common mistakes before they reach the executor:
//   - Stray characters from PowerShell/encoding round-trips
//   - Malformed SQL (missing semicolons, unbalanced quotes)
//   - Python syntax errors
//   - Windows path issues (forward slashes in paths that should be backslashes)
//
// Returns { valid: boolean, sanitized: string, errors: string[] }

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const PY_PATH = 'C:\\Users\\PureTrek\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe';

/**
 * Sanitize a shell command: strip BOM, replacement chars, smart quotes,
 * normalize line endings, and trim.
 */
export function sanitizeShellCommand(command) {
  if (!command || typeof command !== 'string') return { valid: false, sanitized: '', errors: ['command must be a non-empty string'] };
  let sanitized = command
    .replace(/^\uFEFF/, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\r\n/g, '\n')
    .trim();

  const errors = [];

  // Check for common stray characters
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(sanitized)) {
    errors.push('Command contains control characters that may cause execution failures');
    sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  // Check for unbalanced quotes
  const singleQuotes = (sanitized.match(/'/g) || []).length;
  const doubleQuotes = (sanitized.match(/"/g) || []).length;
  if (singleQuotes % 2 !== 0) errors.push('Unbalanced single quotes in command');
  if (doubleQuotes % 2 !== 0) errors.push('Unbalanced double quotes in command');

  // Check for Windows paths with forward slashes (common mistake)
  if (/[a-zA-Z]:\//.test(sanitized)) {
    errors.push('Windows paths should use backslashes, not forward slashes (e.g., C:\\ not C:/)');
  }

  return { valid: errors.length === 0, sanitized, errors };
}

/**
 * Validate Python code syntax using Python's compile().
 */
export function validatePythonCode(code) {
  if (!code || typeof code !== 'string') return { valid: false, errors: ['code must be a non-empty string'] };
  const errors = [];

  // Basic checks
  const lines = code.split('\n');
  let indentStack = [0];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent > indentStack[indentStack.length - 1] && !lines[i-1]?.trim().endsWith(':')) {
      // Indentation increase without colon — might be an error
      // Don't flag, just note
    }
  }

  // Try to compile with Python
  try {
    const tmpFile = `C:\\Users\\PureTrek\\AppData\\Local\\Temp\\validate_${Date.now()}.py`;
    // fs already imported at top
    writeFileSync(tmpFile, code, 'utf8');
    execFileSync(PY_PATH, ['-c', `import py_compile; py_compile.compile('${tmpFile.replace(/\\/g, '\\\\')}', doraise=True)`], {
      timeout: 10000,
      windowsHide: true,
      encoding: 'utf8',
    });
    try { unlinkSync(tmpFile); } catch {}
    return { valid: true, errors: [] };
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message || '';
    const syntaxMatch = msg.match(/SyntaxError: (.+)/);
    const lineMatch = msg.match(/line (\d+)/);
    const err = syntaxMatch ? syntaxMatch[1] : msg.slice(0, 200);
    const lineInfo = lineMatch ? ` (line ${lineMatch[1]})` : '';
    return { valid: false, errors: [`Python syntax error${lineInfo}: ${err}`] };
  }
}

/**
 * Validate a SQL query for safety and correctness.
 */
export function validateSql(sql) {
  if (!sql || typeof sql !== 'string') return { valid: false, errors: ['sql must be a non-empty string'] };
  const errors = [];
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // Check allowed statement types
  if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/.test(upper)) {
    errors.push('Only SELECT, INSERT, UPDATE, DELETE, and WITH queries are allowed. DDL (CREATE, ALTER, DROP) and other statements are blocked for safety.');
  }

  // Check for SQL injection patterns
  if (/;\s*(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(trimmed)) {
    errors.push('Multiple statements with DDL are not allowed');
  }

  // Check for unbalanced quotes
  const singleQuotes = (trimmed.match(/'/g) || []).length;
  if (singleQuotes % 2 !== 0) {
    errors.push('Unbalanced single quotes in SQL query');
  }

  // Check for unclosed parentheses
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) { errors.push('Unbalanced parentheses in SQL query'); break; }
  }
  if (depth > 0) errors.push('Unbalanced parentheses in SQL query (missing closing paren)');

  // Check for missing semicolon on multi-statement (not an error, just a note)
  if (trimmed.includes(';') && !trimmed.endsWith(';')) {
    errors.push('SQL query has a semicolon in the middle but does not end with one');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a tool call's arguments before execution.
 * Returns { valid, sanitizedArgs, errors }.
 */
export function validateToolCall(toolName, args) {
  const errors = [];
  const sanitizedArgs = { ...args };

  switch (toolName) {
    case 'shell-exec':
    case 'shell_exec': {
      const cmd = args?.command || args?.cmd || args?.script || '';
      const result = sanitizeShellCommand(cmd);
      if (!result.valid) errors.push(...result.errors);
      sanitizedArgs.command = result.sanitized;
      break;
    }
    case 'python-exec':
    case 'python_exec': {
      const code = args?.code || args?.script || '';
      const result = validatePythonCode(code);
      if (!result.valid) errors.push(...result.errors);
      break;
    }
    case 'db-query':
    case 'db_query': {
      const sql = args?.sql || args?.query || '';
      const result = validateSql(sql);
      if (!result.valid) errors.push(...result.errors);
      break;
    }
    default:
      // No specific validation for other tools
      break;
  }

  return { valid: errors.length === 0, sanitizedArgs, errors };
}