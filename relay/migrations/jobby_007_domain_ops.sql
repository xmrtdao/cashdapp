-- jobby-007: domain opportunities, found and scored but never sent to
--
-- The idea: find domains that look neglected, work out why, and hand the
-- candidate a scored, explained list of things worth emailing about.
--
-- What this table is NOT is a send queue. There is no `status='sent'` reachable
-- from here, no recipient column, and no drafted body. That is deliberate and it
-- is the reason the schema looks the way it does - see "why there is no send
-- path" below. Phase 1 of this feature scans, scores and surfaces. It does not
-- contact anybody.
--
-- WHY WHOIS IS NOT IN HERE
--
-- The original design was: if a domain is parked, WHOIS the owner and email
-- them. That was built on an assumption that stopped being true in 2018, and it
-- is worth writing down here because the next person will have the same idea.
--
-- Verified against the live registry on 2026-10-07, not from memory:
--
--   whois.verisign-grs.com / example.com  -> registrar, dates, nameservers.
--                                             No registrant. No email. No country.
--   rdap.verisign.com  / godaddy.com      -> one entity, roles=["registrar"].
--                                             No registrant entity exists.
--   rdap.verisign.com  / ebay.com         -> the only email in the entire
--                                             document is
--                                             abusecomplaints@markmonitor.com
--                                             - MarkMonitor's ABUSE desk. Not
--                                             eBay. Not an owner.
--
-- Registrar-level WHOIS, where registrant data used to live, is shut:
--
--   whois.godaddy.com    -> "No match"
--   whois.cloudflare.com -> "No match"
--   whois.namecheap.com  -> timeout
--   whois.hover.com      -> timeout
--
-- So the honest yield of a WHOIS lookup on a modern .com is: registration date,
-- expiry, registrar, nameservers, and nothing that identifies a human. There is
-- no `owner_email` column here because there is no such value to put in it. A
-- column for it would be a column that is always NULL, which is worse than no
-- column: it reads as "we looked and there wasn't one" when the truth is "we
-- could not have found one."
--
-- The registry response also carries its own terms, and they name this use case:
--
--   "...under no circumstances will you use this Data to: (1) allow, enable, or
--    otherwise support the transmission of mass unsolicited, commercial
--    advertising or solicitations via e-mail..."
--
-- Contact data therefore comes from somewhere that consented to publish it: the
-- live site itself, via webScrape({extractLinks:true}). That is the only source
-- in this table, and it is the only one that is a person's actual choice.
--
-- WHERE THE VALUE ACTUALLY IS
--
-- The original spec said "if it renders a page, move on; if it is parked,
-- email the owner." That branch structure inverts the value. A parked page is
-- the one state with no owner contact in it - the broker page is the broker's,
-- not the owner's. A real but neglected site is the state where the owner put
-- their own address in their own HTML.
--
-- So parked domains are still scanned and still scored - they are cheap to
-- check and the "is this for sale to a speculator or did a business die" answer
-- is worth recording. They just almost never produce a contact. Live-weak
-- domains are the ones that reach a human. `contact_source` records which of
-- the two happened, per row, so nobody has to guess later.

BEGIN;

CREATE TABLE IF NOT EXISTS app.job_domain_candidates (
  id          bigserial PRIMARY KEY,

  -- The domain itself, lowercased, no scheme and no www. This is the identity
  -- of the row: two keywords that generate the same domain are one candidate,
  -- not two, and a candidate that is rescanned keeps its score history.
  domain      text NOT NULL,

  -- Which keyword produced it, kept so "why was this one looked at" is
  -- answerable after the fact. A domain with no keyword behind it cannot be
  -- explained to the candidate, and an unexplainable list is a list they cannot
  -- act on.
  keyword     text,

  -- Which TLD. Kept as its own column because "is .com taken" and "is .io
  -- taken" are different questions with different answers, and a schema that
  -- only stores the full domain makes that impossible to ask cheaply.
  tld         text,

  -- DNS state at last check: resolves | no_record | error. Kept separately
  -- from http_state because a domain with no A record is a real finding (it may
  -- be for sale, or dead) and not the same as one whose web server refuses us.
  dns_state   text NOT NULL DEFAULT 'unknown',
  CONSTRAINT dns_state_is_known
    CHECK (dns_state IN ('unknown','resolves','no_record','error')),

  -- parked | live_weak | live_strong | unreachable | blocked
  --
  -- `blocked` is a RESULT, not a failure: HTTP 401/403/429 means something is
  -- there and something declined to be read. Collapsing that into
  -- "unreachable" would report "nothing there" about a page we were told no.
  http_state  text NOT NULL DEFAULT 'unknown',
  CONSTRAINT http_state_is_known
    CHECK (http_state IN ('unknown','parked','live_weak','live_strong',
                          'unreachable','blocked')),

  http_status integer,
  page_title  text,
  final_url   text,
  -- Which signature matched, verbatim: "sedo", "godaddy", "for-sale-text".
  -- A classifier that cannot say what it matched on is a guess, and the whole
  -- point of the model scoring below is to have something concrete to reason
  -- from. Same rule as job_claim_verifications.evidence.
  signature   text,

  -- The contact address, but ONLY if it was read off the site itself.
  contact_email text,
  -- How it was found: mailto_href | body_regex | contact_page | none.
  -- 'none' is a recorded outcome with meaning - "we looked at the site and it
  -- publishes no address" - and is not the same as having never looked.
  contact_source text,
  CONSTRAINT contact_source_is_known
    CHECK (contact_source IS NULL OR
           contact_source IN ('mailto_href','body_regex','contact_page','none')),

  -- A contact is only ever stored alongside the page it came from, so a reader
  -- can see the address on the actual site rather than trusting us.
  contact_evidence jsonb,

  -- 0-100 from the model, over `score_reason`.
  score       integer,
  CONSTRAINT score_in_range CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  -- The model's actual reasoning, stored verbatim. An opportunity score with no
  -- stated reason is not an opportunity, it is a number.
  score_reason text,
  -- 'parked' | 'underused' | 'healthy' | 'unknown'
  verdict     text,
  CONSTRAINT verdict_is_known
    CHECK (verdict IS NULL OR
           verdict IN ('parked','underused','healthy','unknown')),
  scored_at   timestamptz,
  -- Which model actually produced the score. A score with no model attached
  -- cannot be re-checked when the model changes, which is when you most want to.
  scored_by   text,

  -- Everything the scan saw, so a scoring decision can be audited and re-run.
  evidence    jsonb,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scored_has_reason CHECK (score IS NULL OR score_reason IS NOT NULL)
);

-- Re-runnable, for the same reason every migration here repeats its columns:
-- CREATE TABLE IF NOT EXISTS silently does nothing to a table that already
-- exists, so a column added to the definition above would never reach a live
-- database.
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS keyword text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS tld text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS dns_state text NOT NULL DEFAULT 'unknown';
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS http_state text NOT NULL DEFAULT 'unknown';
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS http_status integer;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS page_title text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS final_url text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS signature text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS contact_source text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS contact_evidence jsonb;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS score integer;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS score_reason text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS verdict text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS scored_at timestamptz;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS scored_by text;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS evidence jsonb;
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app.job_domain_candidates ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- The constraints have to be re-added too. ADD CONSTRAINT IF NOT EXISTS does
-- not exist in postgres, so each is attempted and an "already exists" notice is
-- ignored - the standard way to make a constraint re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dns_state_is_known') THEN
    ALTER TABLE app.job_domain_candidates
      ADD CONSTRAINT dns_state_is_known
      CHECK (dns_state IN ('unknown','resolves','no_record','error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'http_state_is_known') THEN
    ALTER TABLE app.job_domain_candidates
      ADD CONSTRAINT http_state_is_known
      CHECK (http_state IN ('unknown','parked','live_weak','live_strong',
                            'unreachable','blocked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_source_is_known') THEN
    ALTER TABLE app.job_domain_candidates
      ADD CONSTRAINT contact_source_is_known
      CHECK (contact_source IS NULL OR
             contact_source IN ('mailto_href','body_regex','contact_page','none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verdict_is_known') THEN
    ALTER TABLE app.job_domain_candidates
      ADD CONSTRAINT verdict_is_known
      CHECK (verdict IS NULL OR
             verdict IN ('parked','underused','healthy','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_in_range') THEN
    ALTER TABLE app.job_domain_candidates
      ADD CONSTRAINT score_in_range
      CHECK (score IS NULL OR (score >= 0 AND score <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scored_has_reason') THEN
    ALTER TABLE app.job_domain_candidates
      ADD CONSTRAINT scored_has_reason
      CHECK (score IS NULL OR score_reason IS NOT NULL);
  END IF;
END $$;

COMMENT ON TABLE app.job_domain_candidates IS
  'Domains scanned for money opportunities. Phase 1 records and scores only - it contacts nobody. There is deliberately no recipient column and no send status, because no send path exists.';
COMMENT ON COLUMN app.job_domain_candidates.contact_email IS
  'Only ever populated from an address published on the site itself. NEVER from WHOIS or RDAP: the registry returns no registrant contact for modern .com registrations, and its terms of use forbid using that data for solicitations.';
COMMENT ON COLUMN app.job_domain_candidates.contact_source IS
  'How the address was found. ''none'' means the site was read and published nothing, which is a finding. NULL means it was never looked for.';
COMMENT ON COLUMN app.job_domain_candidates.http_state IS
  '''blocked'' is a result, not a failure - a 403 means something is there and declined to be read, which is not the same as nothing being there.';
COMMENT ON COLUMN app.job_domain_candidates.score IS
  'Model opinion 0-100 over score_reason. A score without a stated reason is not an opportunity, it is a number.';

-- One row per domain, globally. The scan is a shared resource rather than a
-- per-candidate one: two candidates looking at the same keyword should not each
-- pay for the same HTTP request, and a domain's real state does not depend on
-- who is looking at it.
DROP INDEX IF EXISTS job_domain_candidates_one_per_domain;
CREATE UNIQUE INDEX IF NOT EXISTS job_domain_candidates_one_per_domain
  ON app.job_domain_candidates (domain);

-- The board query: best first, only the scored ones.
CREATE INDEX IF NOT EXISTS job_domain_candidates_scored
  ON app.job_domain_candidates (score DESC NULLS LAST, last_seen_at DESC)
  WHERE score IS NOT NULL;

-- The queue: uncontactable parked domains, which the daemon should not waste
-- re-scraping at full cost every tick.
CREATE INDEX IF NOT EXISTS job_domain_candidates_parked
  ON app.job_domain_candidates (last_seen_at)
  WHERE http_state = 'parked' AND contact_email IS NULL;

-- A contact is a personal address. Index it so the suppression check in phase 2
-- is a single index probe rather than a table scan of a growing domain list.
CREATE INDEX IF NOT EXISTS job_domain_candidates_contact
  ON app.job_domain_candidates (lower(contact_email))
  WHERE contact_email IS NOT NULL;

-- Suppression, arriving in phase 1 even though nothing sends yet.
--
-- The point of creating it now is that a table that is retrofitted at the moment
-- it is first needed is a table nobody tests. And there is a reason this one
-- exists at all: `jobby_send` checks no suppression list today. Its only
-- consent-shaped gate is `passesDisclosure`, which is a bot-disclosure rule,
-- not an opt-out. The opt-out list the relay already has,
-- public.pfp_campaign_suppressions, is not consulted by that path.
CREATE TABLE IF NOT EXISTS app.job_suppressions (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  -- Why this address is suppressed: owner_request | hard_bounce | complaint |
  -- manual | abuse_report
  reason     text NOT NULL,
  CONSTRAINT suppression_reason_is_known
    CHECK (reason IN ('owner_request','hard_bounce','complaint','manual','abuse_report')),
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.job_suppressions ADD COLUMN IF NOT EXISTS detail text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suppression_reason_is_known') THEN
    ALTER TABLE app.job_suppressions
      ADD CONSTRAINT suppression_reason_is_known
      CHECK (reason IN ('owner_request','hard_bounce','complaint','manual','abuse_report'));
  END IF;
END $$;

-- Lowercased, because "Bob@Example.com" and "bob@example.com" are one person and
-- treating them as two is exactly how an opt-out gets honored on Tuesday and
-- mailed on Wednesday.
DROP INDEX IF EXISTS job_suppressions_one_per_email;
CREATE UNIQUE INDEX IF NOT EXISTS job_suppressions_one_per_email
  ON app.job_suppressions (lower(email));

COMMENT ON TABLE app.job_suppressions IS
  'Addresses that must never be emailed. Checked on every send, in phase 2. An owner_request row is permanent and is never removed by an automated process.';

-- What each scan run did, so the daemon can be audited like any other job.
CREATE TABLE IF NOT EXISTS app.job_domain_runs (
  id          bigserial PRIMARY KEY,
  -- The keyword set this run covered.
  keywords    text[],
  requested   integer NOT NULL DEFAULT 0,
  -- What actually happened, which is not the same number: a domain whose HTTP
  -- fetch was refused was requested but not checked.
  checked     integer NOT NULL DEFAULT 0,
  found       integer NOT NULL DEFAULT 0,
  scored      integer NOT NULL DEFAULT 0,
  contacted   integer NOT NULL DEFAULT 0,
  -- Why the run stopped short of its target, when it did.
  stopped_reason text,
  duration_ms integer,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS keywords text[];
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS requested integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS checked integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS found integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS scored integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS contacted integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS stopped_reason text;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE app.job_domain_runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;

COMMENT ON TABLE app.job_domain_runs IS
  'One row per scan pass. requested is what the daemon asked for, checked is what it actually looked at. A run that requested 50 and checked 3 is a real failure and the two numbers are stored separately so it is visible.';

CREATE INDEX IF NOT EXISTS job_domain_runs_recent
  ON app.job_domain_runs (started_at DESC);

COMMIT;
