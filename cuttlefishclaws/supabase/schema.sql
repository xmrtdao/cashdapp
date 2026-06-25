-- ============================================================
-- cuttlefishclaws.com — Supabase Schema
-- Tributary AI Campus / Cuttlefish Labs
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Project: vyggodkclzcmfycdovqi
-- ============================================================

-- ── CAC credentials (create first — agents reference this) ──
CREATE TABLE IF NOT EXISTS cac_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_did       TEXT NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('explorer','developer','studio','enterprise')),
  token_balance   BIGINT DEFAULT 0,
  usdc_prepaid    NUMERIC(12,2) DEFAULT 0,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','active','depleted','expired','exiting','transferred')),
  chain_tx_hash   TEXT,
  issued_at       TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Agent registry ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  did               TEXT UNIQUE NOT NULL,
  agent_type        TEXT NOT NULL CHECK (agent_type IN ('constitutional','developer','financial')),
  name              TEXT,
  operator_did      TEXT,
  cac_id            UUID REFERENCES cac_credentials(id),
  trust_score       NUMERIC(5,2) DEFAULT 50.0 CHECK (trust_score >= 0 AND trust_score <= 100),
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','decommissioned')),
  constitution_hash TEXT,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Proposals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  description      TEXT,
  category         TEXT DEFAULT 'general',
  submitter_did    TEXT NOT NULL,
  version          INTEGER DEFAULT 1 CHECK (version >= 1),
  parent_id        UUID REFERENCES proposals(id),
  status           TEXT DEFAULT 'submitted' CHECK (
                     status IN ('submitted','routing','under_review','approved','rejected','archived')
                   ),
  ipfs_cid         TEXT,
  arweave_tx       TEXT,
  chain_anchor_tx  TEXT,
  combined_hash    TEXT NOT NULL,
  routed_to        TEXT[] DEFAULT '{}',
  trust_score_delta NUMERIC(5,2),
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── TrustGraph event log (append-only) ───────────────────────
CREATE TABLE IF NOT EXISTS trust_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_did    TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  delta        NUMERIC(5,2) NOT NULL,
  score_after  NUMERIC(5,2) NOT NULL CHECK (score_after >= 0 AND score_after <= 100),
  reference    TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Agent task queue ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type     TEXT NOT NULL,
  assigned_to   TEXT NOT NULL CHECK (assigned_to IN ('trib','arch','nautiloid','dao-voters')),
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed')),
  priority      INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  error_msg     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  picked_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- ── Capital stack layers ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS capital_stack (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_key     TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  sub_label     TEXT NOT NULL,
  amount_m      NUMERIC(10,4) NOT NULL,
  pct_of_total  NUMERIC(6,3) NOT NULL,
  color         TEXT NOT NULL,
  seniority     NUMERIC(4,3) NOT NULL,
  yield_score   NUMERIC(4,3) NOT NULL,
  coverage      NUMERIC(4,3) NOT NULL,
  description   TEXT,
  details       TEXT,
  display_order INTEGER DEFAULT 0,
  is_open       BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Financing programs ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS financing_programs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_key          TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL,
  administering_entity TEXT NOT NULL,
  applies_to           TEXT[] NOT NULL,
  headline             TEXT NOT NULL,
  amount_range         TEXT,
  rate_or_credit       TEXT,
  term_years           TEXT,
  eligibility          TEXT,
  application_url      TEXT,
  contact              TEXT,
  notes                TEXT,
  is_active            BOOLEAN DEFAULT TRUE,
  display_order        INTEGER DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_agents_did          ON agents(did);
CREATE INDEX IF NOT EXISTS idx_agents_status       ON agents(status);
CREATE INDEX IF NOT EXISTS idx_cac_agent_did       ON cac_credentials(agent_did);
CREATE INDEX IF NOT EXISTS idx_proposals_submitter ON proposals(submitter_did);
CREATE INDEX IF NOT EXISTS idx_proposals_status    ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_trust_events_did    ON trust_events(agent_did);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned      ON agent_tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_capital_order       ON capital_stack(display_order);
CREATE INDEX IF NOT EXISTS idx_financing_order     ON financing_programs(display_order);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE agents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE cac_credentials    ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE capital_stack      ENABLE ROW LEVEL SECURITY;
ALTER TABLE financing_programs ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "public_trust_read"
  ON trust_events FOR SELECT USING (true);

CREATE POLICY "public_proposal_read"
  ON proposals FOR SELECT USING (status != 'archived');

CREATE POLICY "public_capital_read"
  ON capital_stack FOR SELECT USING (is_active = TRUE);

CREATE POLICY "public_financing_read"
  ON financing_programs FOR SELECT USING (is_active = TRUE);

-- ============================================================
-- updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER capital_stack_updated_at
  BEFORE UPDATE ON capital_stack
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER financing_programs_updated_at
  BEFORE UPDATE ON financing_programs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Seed: Capital Stack
-- ============================================================
INSERT INTO capital_stack (layer_key, name, sub_label, amount_m, pct_of_total, color, seniority, yield_score, coverage, description, details, display_order, is_open) VALUES
('cpace',
 'C-PACE', 'Senior Retrofit Lien', 25.5, 75.0, '#00c8ff', 0.88, 0.72, 0.92,
 'No personal guarantee · Transfers with property · 25-30yr term · Senior assessment lien',
 'C-PACE finances the $25.5M energy retrofit through a voluntary property tax assessment under Alabama SB220 (2016). Senior lien. Transfers automatically at property sale. 5-10% interest over 25-30 years. Covers solar reactivation, HVAC electrification, EV charging, building automation, and energy storage.',
 1, FALSE),
('sba_private',
 'SBA Private', '1st Lien · ~50% LTV', 2.75, 8.0, '#ffbb33', 0.70, 0.60, 0.75,
 '~50% LTV · First lien position · Private bank · Standard SBA 504 structure',
 'Private lender first lien at approximately 50% loan-to-value. Part of SBA 504 three-part structure: private lender (50%) + CDC debenture (40%) + borrower equity (10%). Collateral limited to property.',
 2, FALSE),
('sba_cdc',
 'SBA 504', '2nd Lien · CDC Debenture', 2.2, 6.5, '#ffbb33', 0.60, 0.68, 0.65,
 '25-yr fixed 6.44% · Government-backed · 2nd lien · No personal guarantee',
 'SBA 504 CDC debenture at 6.44% fixed for 25 years (April 2026 NADCO rate). SBA-guaranteed. Alabama CDCs: FBDC, Alabama Small Business Capital. AI equipment explicitly eligible under SBA 2024 guidance.',
 3, FALSE),
('dao_reit',
 'DAO-REIT', 'Equity · Open Now', 0.55, 1.6, '#ff00cc', 0.28, 0.95, 0.30,
 '10% equity down · Tokenized via Delaware Series LLC · DAO governance · Min $25K',
 '$550K equity tranche tokenized via Delaware Series LLC. Minimum $25K. AI agents invest via Coinbase AgentKit wallets. Birmingham Opportunity Zone — federal capital gains deferral and elimination available (OZ 1.0 through Dec 2028). Alabama state OZ match via ADECA ($50M cap).',
 4, TRUE),
('founder',
 'Founder', 'Equity Floor · Subordinate', 0.055, 0.18, '#00ff88', 0.18, 1.00, 0.20,
 'Delaware Series LLC · No personal guarantee beyond this position · Fully subordinate',
 'Founder equity floor — $55K at risk. Delaware Series LLC isolates asset from Cuttlefish Labs operating entity. No personal guarantee beyond this position. FounderShare.sol: 6-trigger constitutional veto.',
 5, FALSE)
ON CONFLICT (layer_key) DO UPDATE SET
  description = EXCLUDED.description,
  details     = EXCLUDED.details,
  updated_at  = NOW();

-- ============================================================
-- Seed: Financing Programs (17 programs)
-- ============================================================
INSERT INTO financing_programs
(program_key, name, category, administering_entity, applies_to, headline, amount_range, rate_or_credit, term_years, eligibility, application_url, contact, notes, display_order)
VALUES
('sba_504','SBA 504 Loan Program','federal_loan','U.S. Small Business Administration — Certified Development Companies',ARRAY['sba_cdc','sba_private'],'Below-market fixed-rate financing for commercial real estate and AI infrastructure','Up to $5.5M CDC debenture; no cap on private lender 50%','6.44% fixed 25-yr (April 2026 NADCO)','10, 20, or 25 years','For-profit US company. Net worth <$20M. Avg net income <$6.5M/2yr. 10% borrower equity. Owner-occupied CRE. AI-supported equipment explicitly eligible (SBA 2024). Data centers min 20 net new jobs.','https://www.sba.gov/funding-programs/loans/504-loans','Alabama CDCs: FBDC (fbdc.net, 205-324-7244) · Alabama Small Business Capital','Three-part structure: 50% private lender + 40% CDC debenture (SBA-guaranteed) + 10% equity. Birmingham OZ location may qualify for enhanced terms. Apply before public announcement.',10),

('doe_loan_program','DOE Loan Programs Office (LPO) — Title 17','federal_loan','U.S. Department of Energy — Loan Programs Office',ARRAY['cpace','dao_reit'],'Loan guarantees for innovative clean energy and brownfield AI+energy deployments','$1M to multi-billion; project-specific','Below-market; Treasury-indexed','5–30 years','Innovative clean energy technology. Brownfield redevelopment with clean energy component. C-PACE retrofit + solar + battery storage on former telecom facility is strong candidate.','https://www.energy.gov/lpo/loan-programs-office','DOE LPO: lpo.energy.gov','July 2025 EO directs Commerce to launch financial support for AI data centers. LPO pipeline is 1-2 years — apply early.',11),

('alabama_infra_bank','Alabama Infrastructure Bank (Powering Growth Act)','state_loan','Alabama Department of Commerce / EDPA',ARRAY['cpace','dao_reit'],'Flexible financing for power infrastructure tied to industrial growth — signed into law 2025','Project-specific; no stated cap at launch','Below-market; bond-financed','Project-specific','Industrial projects requiring power infrastructure in Alabama. Tributary campus power upgrade tied to AI campus job creation. New program — early engagement critical.','https://edpa.org/','EDPA: edpa.org · (205) 943-4700','Brand new 2025 program. EDPA and AL Dept of Commerce co-administering. Birmingham/Jefferson County OZ designation is an advantage.',20),

('al_industrial_dev_bonds','Alabama Industrial Development Bond Program','state_loan','State Industrial Development Authority / Jefferson County IDB',ARRAY['sba_private','dao_reit'],'Tax-exempt bond financing — no ad valorem tax on financed property','Project-specific','Tax-exempt; below-market','10–30 years','Industrial and technology projects via local Industrial Development Boards. No ad valorem tax on land/buildings/equipment financed by bonds. Sales & Use Tax exemptions apply.','https://edpa.org/','Jefferson County IDB · Birmingham Business Alliance: (205) 324-2100','Alabama Act 91-635. Coordinate with Jefferson County Commission and City of Birmingham. Can layer with SBA 504 and C-PACE.',21),

('alabama_jobs_act','Alabama Jobs Act — Jobs Credit + Investment Credit','state_tax','Alabama Department of Commerce + Alabama Department of Revenue',ARRAY['dao_reit','founder'],'3-4% annual payroll rebate + 1.5% investment credit; data centers get 30-yr property tax abatement','3-4% of payroll/yr × 10yr + 1.5% of capex/yr × 10yr','Cash rebate + tax credit','10yr credits; up to 30yr data center property tax abatement','Min 20 net new jobs for data centers (vs standard 50). Technology companies eligible for 4% rate. Jefferson County is not a targeted county — standard rate. MUST apply before public announcement.','https://www.madeinalabama.com/why-alabama/incentives/','AL Dept of Commerce: (334) 242-0400 · Birmingham Business Alliance: (205) 324-2100','Data processing centers get 30-year property tax abatement (vs standard 20yr). Cannot stack with 40-9G — choose one. Transferable investment credit first 3 years (85% min value). Apply BEFORE public announcement.',30),

('al_reinvestment_abatements','Alabama Reinvestment and Abatements Act (40-9G)','state_tax','Alabama Department of Revenue',ARRAY['cpace','sba_private'],'Sales/use and property tax abatements for existing facility upgrade — no minimum job requirement','Full abatement of non-educational sales/use and property taxes','Full abatement','Up to 20yr property tax; 10yr utility tax','Existing facility refurbishment or placed back in service. Min $2M capital investment. No minimum job count. Cannot stack with Jobs Act — choose one.','https://www.revenue.alabama.gov/division/tax-incentives/','AL Dept of Revenue: (334) 242-1175','Best fit for Tributary: placed back in service category. No job minimum. Utility tax exemption covers AI compute electricity loads. Coordinate approvals with Jefferson County and City of Birmingham.',31),

('al_oz_match','Alabama Incentives and Modernization Act — OZ Impact Investment Credit','state_tax','Alabama Department of Economic & Community Affairs (ADECA)',ARRAY['dao_reit'],'State income tax credit if OZ investment underperforms agreed return — downside protection','$50M aggregate state program cap','Impact Investment Credit vs AL income/excise taxes','Per ADECA project agreement','Investment in ADECA-approved Opportunity Fund investing in Alabama OZ project. File IRS Form 8996. Project agreement with ADECA required.','https://adeca.alabama.gov/opportunityzones/','ADECA: (334) 242-5100','$50M cap is statewide aggregate — early movers advantaged. Confirm 2025/2026 availability with ADECA. Layerable on top of federal OZ §1400Z-2 benefits.',32),

('growing_alabama','Growing Alabama Credit Program','state_tax','Alabama Department of Commerce + EDPA',ARRAY['dao_reit','cpace'],'Dollar-for-dollar state tax credit for contributions to EDPA-approved projects','Up to 50% of taxpayer AL tax liability','Dollar-for-dollar state tax credit','Per project','Alabama taxpayers with state tax liability. Contributions to approved Economic Development Organizations. Coordinate with Birmingham Business Alliance or Jefferson County EDO.','https://edpa.org/programs-services/state-tax-incentive-programs/','EDPA: (205) 943-4700','Converts Alabama tax liability into Tributary project capital. Maximum 50% of AL tax liability per year. Must coordinate with local EDO.',33),

('oz_federal','Qualified Opportunity Zone — Federal (IRC §1400Z-2)','federal_tax','U.S. Treasury / IRS',ARRAY['dao_reit','founder'],'Defer and eliminate capital gains by investing in Birmingham OZ via Qualified Opportunity Fund','No minimum; Tributary DAO-REIT min $25K','Full gains elimination after 10yr hold','OZ 1.0 through Dec 31, 2028; OZ 2.0 effective Jan 1, 2027','US taxpayer with eligible capital gains. Invest via QOF within 180 days of gain. Property in designated OZ census tract. Birmingham: 24 OZs. Hold ≥10 years for full elimination.','https://opportunityzones.com/cities/birmingham-alabama/','Opportunity Alabama (OPAL): opportunityalabama.com · IRS: irs.gov/credits-deductions/opportunity-zones','OZ 2.0 (OBBBA July 2025): program made permanent. New designations ~141 Alabama tracts effective Jan 1, 2027. Confirm Tributary campus census tract vs IRS Notice 2018-48.',40),

('itc_48','Investment Tax Credit — IRC §48','federal_tax','U.S. Internal Revenue Service / U.S. Treasury',ARRAY['cpace'],'30% federal tax credit on solar, battery storage, EV charging — up to 50% with bonus adders','No cap — 30% of eligible project cost base','30% base; +10% energy community; +10% domestic content','Credit taken year placed in service','Solar PV, battery storage ≥5kWh, EV charging, fuel cells. Birmingham potentially qualifies as energy community — 10% bonus. Prevailing wage + apprenticeship for projects >1MW.','https://www.irs.gov/credits-deductions/businesses/investment-tax-credit','IRS: irs.gov · DOE: energy.gov/policy/clean-energy-tax-incentives','$25.5M C-PACE project at 30% ITC = ~$7.65M federal credit. Requires tax equity partner or direct pay election (IRC §6417). ITC stacks on top of C-PACE.',41),

('bonus_depreciation','Bonus Depreciation / MACRS Accelerated (IRC §168)','federal_tax','U.S. Internal Revenue Service',ARRAY['sba_private','dao_reit'],'100% bonus depreciation on qualifying equipment — restored by OBBBA July 2025','Full cost basis of qualifying assets','100% depreciation year 1','Year placed in service','Equipment with useful life ≤20 years, Qualified Improvement Property. Data center equipment (servers, networking, power, HVAC) qualifies. Restored to 100% by OBBBA for assets placed in service after Jan 20, 2025.','https://www.irs.gov/newsroom/bonus-depreciation','IRS: irs.gov/publications/p946','OBBBA (July 2025) restored 100% bonus depreciation. All data center equipment and QIP can be fully depreciated year 1. Dramatically accelerates tax shield for DAO-REIT investors.',42),

('eda_public_works','EDA Public Works & Economic Adjustment Assistance','federal_grant','U.S. Economic Development Administration (Dept of Commerce)',ARRAY['cpace','dao_reit'],'Competitive grants for infrastructure in distressed communities — brownfield redevelopment covered','$100K–$10M+ competitive','Grant (no repayment)','No repayment','Eligible: Economic Development Districts, state/local government, nonprofits, universities. NOT direct to for-profit. Partner with City of Birmingham or Jefferson County as co-applicant. Birmingham qualifies as distressed area.','https://www.eda.gov/funding/funding-opportunities/all-opportunities','EDA Atlanta Regional Office: (404) 730-3002','$466M FY2026 EDA appropriation. Apply via grants.gov. City of Birmingham or Jefferson County must be the applicant — Cuttlefish Labs is private partner.',50),

('eda_tech_hubs','EDA Tech Hubs Program — Phase 2 Implementation Grants','federal_grant','U.S. Economic Development Administration',ARRAY['dao_reit'],'$220M for regions to become globally competitive in critical technologies','Up to $75M per hub','Grant (no repayment)','Multi-year','Only 19 designated Tech Hubs eligible for Phase 2. Check if Alabama/Birmingham is designated. Stage II deadline Feb 18, 2026.','https://www.eda.gov/funding/programs/tech-hubs','EDA: eda.gov/funding/programs/tech-hubs','If Birmingham is not a designated Hub, support Alabama designation bid. Tributary campus as anchor asset strengthens any Alabama Tech Hub proposal.',51),

('doe_better_buildings','DOE Better Buildings Initiative + C-PACE Navigator','federal_grant','U.S. Department of Energy — SCEP',ARRAY['cpace'],'Free technical assistance and competitive grants for commercial clean energy retrofits','Technical assistance free; grants $50K–$5M typical','Grant / free TA','Project-specific','Commercial property owners pursuing energy efficiency or renewable energy improvements. Alabama DOE region.','https://betterbuildingssolutioncenter.energy.gov/financing-navigator/option/cpace','DOE Better Buildings: 1-877-337-3463','DOE C-PACE navigator tool is free. Useful for establishing C-PACE precedent with Jefferson County. Joining Better Buildings Challenge provides national recognition.',52),

('epa_brownfields','EPA Brownfields Assessment and Cleanup Grants','federal_grant','U.S. Environmental Protection Agency',ARRAY['cpace','dao_reit'],'Grants for Phase I/II environmental assessments and cleanup — former telecom facility may qualify','Assessment: up to $500K. Cleanup: up to $500K. Multi-purpose: up to $1M.','Grant (no repayment)','Project-specific','Eligible: local governments, nonprofits, quasi-governmental. City of Birmingham or Jefferson County applies. Former telecom/industrial facility qualifies as brownfield.','https://www.epa.gov/brownfields/types-brownfields-grant-funding','EPA Region 4: (404) 562-9900','Phase I/II environmental assessments are prerequisite for C-PACE and federal programs. Apply through City of Birmingham as co-applicant.',53),

('dc_eo_ai','Presidential EO — Accelerating Data Center Infrastructure (July 23, 2025)','federal_grant','U.S. Department of Commerce + DOE + DOI',ARRAY['cpace','dao_reit'],'Federal financial support initiative for AI data centers: loans, grants, tax incentives, offtake agreements','TBD — Commerce initiative launching 2025-2026','Program-specific','Program-specific','AI data centers. Commerce initiative may cover brownfield conversions. Federal lands and brownfield sites prioritized. NEPA streamlined for projects where federal assistance <50% of total cost.','https://www.whitehouse.gov/presidential-actions/2025/07/accelerating-federal-permitting-of-data-center-infrastructure/','Dept of Commerce: commerce.gov · FAST-41: permits.performance.gov','EO signed July 23, 2025. Register project with FPISC for FAST-41 designation — streamlines permitting. Tributary is a strong fit: brownfield, AI infrastructure, OZ location, clean energy.',54),

('aidt_workforce','AIDT — Alabama Industrial Development Training','state_program','AIDT (Alabama Department of Commerce)',ARRAY['dao_reit','founder'],'Free customized workforce training for qualifying Alabama industries','Full cost of training at no charge to employer','Free (state-funded)','Ongoing','New or expanding Alabama industry. Data center projects min 20 jobs. AI/technology operations training available. AIDT is ISO 9001:2015 certified.','https://aidt.edu/','AIDT: (334) 244-1885','Often called Alabama''s #1 incentive. Design curriculum for AI campus operations, constitutional AI governance, agent management. Zero cost. Coordinate early.',60)

ON CONFLICT (program_key) DO UPDATE SET
  notes      = EXCLUDED.notes,
  updated_at = NOW();
