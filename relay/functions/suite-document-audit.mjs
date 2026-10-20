
/**
 * ef:suite-document-audit
 * The Intelligence Core of the Suite Document OS.
 * Orchestrates: Ingest -> Domain Audit -> Legal Audit -> Risk Map.
 */

import { handler as ingest } from './suite-doc-ingest.mjs';
import { detectDocumentType, detectJurisdiction, STATUTE_REGISTRY } from './lease-analyzer.mjs';
import { DE_RULES, MD_RULES, NY_RULES, PA_RULES, NJ_RULES } from './state-rules.mjs';

const ALL_STATE_RULES = [].concat(DE_RULES, MD_RULES, NY_RULES, PA_RULES, NJ_RULES);

export async function handler(payload) {
  const { filePath, userId } = payload;

  try {
    // 1. Ingest
    const ingestResult = await ingest({ filePath });
    if (!ingestResult.success) throw new Error(`Ingest failed: ${ingestResult.error}`);
    const text = ingestResult.text;

    // 2. Classify & Identify Jurisdiction
    const docType = detectDocumentType(text);
    const jurisdiction = detectJurisdiction(text);

    // 3. Run Audits
    const findings = [];

    // A. Legal Rules (Elze)
    const stateSet = ALL_STATE_RULES.find(s => s.state === jurisdiction.code);
    if (stateSet && stateSet.rules[docType]) {
      const rules = stateSet.rules[docType];
      for (const rule of rules) {
        const result = rule.check(text);
        if (result) {
          findings.push({
            id: rule.id,
            title: rule.title,
            severity: rule.severity,
            finding: result.finding,
            cite: result.cite,
            statute: rule.statute,
            source: 'legal-rule'
          });
        }
      }
    }

    // B. Domain/Deterministic Checks (PaperHawk style)
    // In a full impl, we'd call the PaperHawk Python/LangGraph bridge here.
    // For now, we'll implement the primary "Red Flag" placeholders.

    return {
      success: true,
      analysis: {
        documentType: docType,
        jurisdiction: jurisdiction,
        riskScore: calculateRiskScore(findings),
        findings: findings
      },
      context: {
        text: text,
        filePath: filePath
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function calculateRiskScore(findings) {
  const weights = { critical: 10, high: 5, medium: 2, suggestion: 0 };
  const total = findings.reduce((acc, f) => acc + (weights[f.severity] || 0), 0);
  return Math.min(100, total * 2); // Simplified scoring
}
