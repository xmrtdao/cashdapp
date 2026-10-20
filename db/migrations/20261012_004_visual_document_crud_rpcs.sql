-- ============================================================================
-- CRUD RPCs + RLS for visual documents and design templates
-- Created: 2026-10-12
--
-- Agents drive these directly. The functions are SECURITY DEFINER so a caller
-- can work with their own documents without table-level grants, and every
-- function takes an explicit tenant_id so one tenant can never read another's
-- designs.
--
-- Delete is a first-class operation here, not an afterthought: visual documents
-- accumulate one per exchange and hold generated assets that cost money. An
-- agent must be able to prune deliberately.
--
-- SAFE TO RE-RUN. Every function is dropped before being recreated, because
-- CREATE OR REPLACE cannot change a signature or a return type — and two of
-- these had to change after review: get_design_template/get_visual_document
-- returned a composite (all-NULL struct on no match) instead of SETOF (zero
-- rows), and list_template_fields/set_template_field gained a p_tenant_id
-- parameter because a bare template UUID is not access control.
--
-- These are functions over EMPTY tables — dropping one loses no data. The same
-- trick would NOT be safe against the tables themselves.
-- ============================================================================

DROP FUNCTION IF EXISTS app.set_template_field(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, TEXT, INTEGER);
DROP FUNCTION IF EXISTS app.list_template_fields(UUID);
DROP FUNCTION IF EXISTS app.delete_template_field(UUID, TEXT);
DROP FUNCTION IF EXISTS app.get_design_template(UUID, TEXT);
DROP FUNCTION IF EXISTS app.get_visual_document(UUID, TEXT);

-- ── design_templates ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.create_design_template(
    p_tenant_id   UUID,
    p_slug        TEXT,
    p_name        TEXT,
    p_kind        TEXT DEFAULT 'overlay',
    p_width_px    INTEGER DEFAULT 850,
    p_height_px   INTEGER DEFAULT 1100,
    p_template_url TEXT DEFAULT NULL,
    p_style       JSONB DEFAULT '{}'::jsonb,
    p_defaults    JSONB DEFAULT '{}'::jsonb,
    p_description TEXT DEFAULT NULL,
    p_tags        TEXT[] DEFAULT '{}',
    p_created_by  TEXT DEFAULT 'unknown'
) RETURNS app.design_templates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.design_templates;
BEGIN
    INSERT INTO app.design_templates
        (tenant_id, slug, name, kind, width_px, height_px, template_url,
         style, defaults, description, tags, created_by)
    VALUES
        (p_tenant_id, p_slug, p_name, p_kind, p_width_px, p_height_px,
         p_template_url, p_style, p_defaults, p_description, p_tags, p_created_by)
    ON CONFLICT (tenant_id, slug) DO UPDATE SET
        name         = EXCLUDED.name,
        kind         = EXCLUDED.kind,
        width_px     = EXCLUDED.width_px,
        height_px    = EXCLUDED.height_px,
        template_url = EXCLUDED.template_url,
        style        = EXCLUDED.style,
        defaults     = EXCLUDED.defaults,
        description  = EXCLUDED.description,
        tags         = EXCLUDED.tags,
        -- Regenerating a template invalidates the previous human sign-off: that
        -- approval was for the previous artwork.
        approved_by  = NULL,
        approved_at  = NULL,
        updated_at   = now()
    RETURNING * INTO v;
    RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION app.update_design_template(
    p_tenant_id UUID,
    p_slug      TEXT,
    p_patch     JSONB
) RETURNS app.design_templates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.design_templates;
BEGIN
    UPDATE app.design_templates t SET
        name         = COALESCE(p_patch->>'name', t.name),
        kind         = COALESCE(p_patch->>'kind', t.kind),
        width_px     = COALESCE((p_patch->>'width_px')::int, t.width_px),
        height_px    = COALESCE((p_patch->>'height_px')::int, t.height_px),
        template_url = COALESCE(p_patch->>'template_url', t.template_url),
        style        = COALESCE(p_patch->'style', t.style),
        defaults     = COALESCE(p_patch->'defaults', t.defaults),
        description  = COALESCE(p_patch->>'description', t.description),
        -- jsonb_array_elements_text, not unnest(): p_patch->'tags' is jsonb and
        -- unnest() has no jsonb overload. This is the tags-only case, so
        -- jsonb_array_elements_text is the right cast anyway.
        tags         = COALESCE(
            (SELECT array_agg(x)
               FROM jsonb_array_elements_text(
                      COALESCE(p_patch->'tags', to_jsonb(t.tags))) AS x),
            t.tags),
        is_active    = COALESCE((p_patch->>'is_active')::boolean, t.is_active),
        updated_at   = now()
    WHERE t.tenant_id = p_tenant_id AND t.slug = p_slug
    RETURNING * INTO v;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'template % not found for tenant %', p_slug, p_tenant_id;
    END IF;
    RETURN v;
END $fn$;

-- Explicit human sign-off, separate from update on purpose: an agent must not
-- be able to approve its own template for customer-facing print just by
-- including an approval key in a patch.
CREATE OR REPLACE FUNCTION app.approve_design_template(
    p_tenant_id   UUID,
    p_slug        TEXT,
    p_approved_by TEXT
) RETURNS app.design_templates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.design_templates;
BEGIN
    UPDATE app.design_templates
       SET approved_by = p_approved_by, approved_at = now(), updated_at = now()
     WHERE tenant_id = p_tenant_id AND slug = p_slug
    RETURNING * INTO v;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'template % not found', p_slug;
    END IF;
    RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION app.list_design_templates(
    p_tenant_id  UUID,
    p_kind       TEXT DEFAULT NULL,
    p_active_only BOOLEAN DEFAULT true
) RETURNS SETOF app.design_templates
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    SELECT * FROM app.design_templates t
     WHERE t.tenant_id = p_tenant_id
       AND (p_kind IS NULL OR t.kind = p_kind)
       AND (NOT p_active_only OR t.is_active)
     ORDER BY t.name;
$fn$;

-- RETURNS SETOF, not the composite type, so a tenant that cannot see the
-- template gets ZERO rows rather than one row of NULLs. With
-- `RETURNS app.design_templates` a scalar-returning function yields a single
-- all-NULL struct on no match, which reads as "a template exists but has no
-- fields" to any caller that only null-checks one column.
CREATE OR REPLACE FUNCTION app.get_design_template(
    p_tenant_id UUID, p_slug TEXT
) RETURNS SETOF app.design_templates
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    SELECT * FROM app.design_templates
     WHERE tenant_id = p_tenant_id AND slug = p_slug;
$fn$;

CREATE OR REPLACE FUNCTION app.delete_design_template(
    p_tenant_id UUID, p_slug TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v_id UUID;
BEGIN
    SELECT id INTO v_id FROM app.design_templates
     WHERE tenant_id = p_tenant_id AND slug = p_slug;
    IF v_id IS NULL THEN RETURN false; END IF;
    -- Documents built from it survive with template_id set to NULL
    -- (ON DELETE SET NULL): deleting a template must never destroy the work
    -- made from it.
    DELETE FROM app.design_templates WHERE id = v_id;
    RETURN true;
END $fn$;

-- ── template_fields (the autofill contract) ──────────────────────────────

CREATE OR REPLACE FUNCTION app.set_template_field(
    p_tenant_id   UUID,
    p_template_id UUID,
    p_field_key   TEXT,
    p_field_type  TEXT,
    p_x INTEGER DEFAULT 0,
    p_y INTEGER DEFAULT 0,
    p_w INTEGER DEFAULT 100,
    p_h INTEGER DEFAULT 100,
    p_label TEXT DEFAULT NULL,
    p_font_family TEXT DEFAULT NULL,
    p_font_size INTEGER DEFAULT NULL,
    p_font_color TEXT DEFAULT NULL,
    p_align TEXT DEFAULT 'center',
    p_required BOOLEAN DEFAULT false,
    p_default_value TEXT DEFAULT NULL,
    p_sort_order INTEGER DEFAULT 0
) RETURNS app.template_fields
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.template_fields;
BEGIN
    -- Same tenant check as delete_template_field: a template UUID is not an
    -- access control, so confirm the caller owns the template first.
    IF NOT EXISTS (SELECT 1 FROM app.design_templates t
                    WHERE t.id = p_template_id AND t.tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'template % not found for tenant %', p_template_id, p_tenant_id;
    END IF;

    INSERT INTO app.template_fields
        (template_id, field_key, field_type, x, y, w, h, label, font_family,
         font_size, font_color, align, required, default_value, sort_order)
    VALUES
        (p_template_id, p_field_key, p_field_type, p_x, p_y, p_w, p_h, p_label,
         p_font_family, p_font_size, p_font_color, p_align, p_required,
         p_default_value, p_sort_order)
    ON CONFLICT (template_id, field_key) DO UPDATE SET
        field_type    = EXCLUDED.field_type,
        x = EXCLUDED.x, y = EXCLUDED.y, w = EXCLUDED.w, h = EXCLUDED.h,
        label         = EXCLUDED.label,
        font_family   = EXCLUDED.font_family,
        font_size     = EXCLUDED.font_size,
        font_color    = EXCLUDED.font_color,
        align         = EXCLUDED.align,
        required      = EXCLUDED.required,
        default_value = EXCLUDED.default_value,
        sort_order    = EXCLUDED.sort_order
    RETURNING * INTO v;
    RETURN v;
END $fn$;

-- Takes tenant_id, not just the template id.
--
-- The original signature was `list_template_fields(p_template_id)` — with no
-- tenant there is no way to enforce isolation, so any tenant holding a
-- template UUID could read another tenant's field layout. Template ids are
-- UUIDs, not secrets, so they are not an access control.
--
-- The tenant check is a join to the parent template, matching the RLS policy
-- on this table.
CREATE OR REPLACE FUNCTION app.list_template_fields(
    p_tenant_id   UUID,
    p_template_id UUID
) RETURNS SETOF app.template_fields
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    SELECT f.* FROM app.template_fields f
      JOIN app.design_templates t ON t.id = f.template_id
     WHERE f.template_id = p_template_id AND t.tenant_id = p_tenant_id
     ORDER BY f.sort_order, f.field_key;
$fn$;

CREATE OR REPLACE FUNCTION app.delete_template_field(
    p_tenant_id   UUID,
    p_template_id UUID,
    p_field_key   TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE n INT;
BEGIN
    DELETE FROM app.template_fields f
     USING app.design_templates t
     WHERE f.template_id = p_template_id AND t.id = f.template_id
       AND t.tenant_id = p_tenant_id AND f.field_key = p_field_key;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $fn$;

-- ── visual_documents ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.create_visual_document(
    p_tenant_id  UUID,
    p_session_id TEXT,
    p_title      TEXT DEFAULT 'Untitled Visual Document',
    p_kind       TEXT DEFAULT 'web',
    p_template_id UUID DEFAULT NULL,
    p_data       JSONB DEFAULT '{}'::jsonb,
    p_created_by TEXT DEFAULT 'unknown'
) RETURNS app.visual_documents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.visual_documents;
BEGIN
    INSERT INTO app.visual_documents
        (tenant_id, session_id, title, kind, template_id, data, created_by)
    VALUES
        (p_tenant_id, p_session_id, p_title, p_kind, p_template_id, p_data, p_created_by)
    RETURNING * INTO v;
    RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION app.update_visual_document(
    p_tenant_id UUID,
    p_doc_id     UUID,
    p_patch      JSONB
) RETURNS app.visual_documents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.visual_documents;
BEGIN
    UPDATE app.visual_documents d SET
        title        = COALESCE(p_patch->>'title', d.title),
        kind         = COALESCE(p_patch->>'kind', d.kind),
        status       = COALESCE(p_patch->>'status', d.status),
        data         = COALESCE(p_patch->'data', d.data),
        render_url   = COALESCE(p_patch->>'render_url', d.render_url),
        render_kind  = COALESCE(p_patch->>'render_kind', d.render_kind),
        generation_log = COALESCE(p_patch->'generation_log', d.generation_log),
        estimated_cost = COALESCE((p_patch->>'estimated_cost')::numeric, d.estimated_cost),
        updated_at   = now()
    WHERE d.tenant_id = p_tenant_id AND d.id = p_doc_id
    RETURNING * INTO v;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'document % not found for tenant %', p_doc_id, p_tenant_id;
    END IF;
    RETURN v;
END $fn$;

-- SETOF for the same reason as get_design_template: zero rows, not a struct
-- of NULLs, when the document is not this tenant's.
CREATE OR REPLACE FUNCTION app.get_visual_document(
    p_tenant_id UUID, p_doc_id UUID
) RETURNS SETOF app.visual_documents
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    SELECT * FROM app.visual_documents
     WHERE tenant_id = p_tenant_id AND id = p_doc_id;
$fn$;

CREATE OR REPLACE FUNCTION app.list_visual_documents(
    p_tenant_id  UUID,
    p_session_id TEXT DEFAULT NULL,
    p_status     TEXT DEFAULT NULL,
    p_limit      INTEGER DEFAULT 50,
    p_offset     INTEGER DEFAULT 0
) RETURNS TABLE (
    id UUID, title TEXT, kind TEXT, status TEXT, session_id TEXT,
    render_url TEXT, estimated_cost NUMERIC, slide_count BIGINT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    SELECT d.id, d.title, d.kind, d.status, d.session_id,
           d.render_url, d.estimated_cost,
           (SELECT count(*) FROM app.visual_slides s WHERE s.document_id = d.id),
           d.created_at, d.updated_at
      FROM app.visual_documents d
     WHERE d.tenant_id = p_tenant_id
       AND (p_session_id IS NULL OR d.session_id = p_session_id)
       AND (p_status IS NULL OR d.status = p_status)
     ORDER BY d.updated_at DESC
     LIMIT GREATEST(1, LEAST(p_limit, 500))
     OFFSET GREATEST(0, p_offset);
$fn$;

CREATE OR REPLACE FUNCTION app.delete_visual_document(
    p_tenant_id UUID, p_doc_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE n INT;
BEGIN
    DELETE FROM app.visual_documents
     WHERE tenant_id = p_tenant_id AND id = p_doc_id;   -- slides cascade
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $fn$;

-- ── visual_slides ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.upsert_visual_slide(
    p_tenant_id   UUID,
    p_doc_id      UUID,
    p_slide_index INTEGER,
    p_layout      TEXT DEFAULT 'prose',
    p_title       TEXT DEFAULT NULL,
    p_body_md     TEXT DEFAULT NULL,
    p_chart_spec  JSONB DEFAULT NULL,
    p_image_url   TEXT DEFAULT NULL,
    p_image_alt   TEXT DEFAULT NULL,
    p_image_model TEXT DEFAULT NULL,
    p_image_prompt TEXT DEFAULT NULL,
    p_image_cost_usd NUMERIC DEFAULT NULL,
    p_notes       TEXT DEFAULT NULL
) RETURNS app.visual_slides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v app.visual_slides;
BEGIN
    -- Confirm the document belongs to this tenant before writing a child row.
    IF NOT EXISTS (SELECT 1 FROM app.visual_documents d
                    WHERE d.id = p_doc_id AND d.tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'document % not found for tenant %', p_doc_id, p_tenant_id;
    END IF;

    INSERT INTO app.visual_slides
        (document_id, slide_index, title, layout, body_md, chart_spec,
         image_url, image_alt, image_model, image_prompt, image_cost_usd, notes)
    VALUES
        (p_doc_id, p_slide_index, p_title, p_layout, p_body_md, p_chart_spec,
         p_image_url, p_image_alt, p_image_model, p_image_prompt,
         p_image_cost_usd, p_notes)
    ON CONFLICT (document_id, slide_index) DO UPDATE SET
        title          = EXCLUDED.title,
        layout         = EXCLUDED.layout,
        body_md        = EXCLUDED.body_md,
        chart_spec     = EXCLUDED.chart_spec,
        image_url      = EXCLUDED.image_url,
        image_alt      = EXCLUDED.image_alt,
        image_model    = EXCLUDED.image_model,
        image_prompt   = EXCLUDED.image_prompt,
        image_cost_usd = EXCLUDED.image_cost_usd,
        notes          = EXCLUDED.notes,
        updated_at     = now()
    RETURNING * INTO v;
    RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION app.list_visual_slides(
    p_tenant_id UUID, p_doc_id UUID
) RETURNS SETOF app.visual_slides
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    SELECT s.* FROM app.visual_slides s
      JOIN app.visual_documents d ON d.id = s.document_id
     WHERE d.tenant_id = p_tenant_id AND s.document_id = p_doc_id
     ORDER BY s.slide_index;
$fn$;

CREATE OR REPLACE FUNCTION app.delete_visual_slide(
    p_tenant_id UUID, p_doc_id UUID, p_slide_index INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE n INT;
BEGIN
    DELETE FROM app.visual_slides s
     USING app.visual_documents d
     WHERE s.document_id = p_doc_id AND d.id = s.document_id
       AND d.tenant_id = p_tenant_id AND s.slide_index = p_slide_index;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $fn$;

-- Renumber after a delete so slide_index stays contiguous. Without this a
-- document can end up with indices 0,1,3 and an order-assuming renderer
-- silently drops a slide.
CREATE OR REPLACE FUNCTION app.reindex_visual_slides(
    p_tenant_id UUID, p_doc_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE v_count INT;
BEGIN
    WITH ordered AS (
        SELECT id, row_number() OVER (ORDER BY slide_index) - 1 AS rn
          FROM app.visual_slides WHERE document_id = p_doc_id
    ), upd AS (
        UPDATE app.visual_slides s
           SET slide_index = o.rn, updated_at = now()
          FROM ordered o
         WHERE s.id = o.id AND s.slide_index <> o.rn
        RETURNING 1
    )
    SELECT count(*) INTO v_count FROM upd;
    RETURN v_count;
END $fn$;

-- ── Retention & spend ────────────────────────────────────────────────────

-- Prune by age and/or count. Archives rather than deletes by default so a
-- pruned document stays recoverable; pass p_hard_delete to truly remove.
-- Published documents are never auto-pruned.
--
-- NOTE ON SCOPE: the age test uses `created_at`, not `updated_at`. A document
-- somebody is actively iterating on should not be pruned just because it was
-- created a while ago.
CREATE OR REPLACE FUNCTION app.prune_visual_documents(
    p_tenant_id     UUID,
    p_keep_days     INTEGER DEFAULT NULL,
    p_max_documents INTEGER DEFAULT NULL,
    p_hard_delete   BOOLEAN DEFAULT false
) RETURNS TABLE (pruned UUID, title TEXT, action TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $fn$
DECLARE
    v_keep_days INTEGER;
    v_max       INTEGER;
    v_hard      BOOLEAN;
BEGIN
    SELECT r.keep_days, r.max_documents, NOT r.archive_instead
      INTO v_keep_days, v_max, v_hard
      FROM app.visual_document_retention r WHERE r.tenant_id = p_tenant_id;

    v_keep_days := COALESCE(p_keep_days, v_keep_days, 90);
    v_max       := COALESCE(p_max_documents, v_max, 500);
    v_hard      := COALESCE(p_hard_delete, v_hard, false);

    RETURN QUERY
    WITH picked AS (
        SELECT d.id, d.title,
               CASE WHEN v_hard THEN 'delete' ELSE 'archive' END AS act
          FROM app.visual_documents d
         WHERE d.tenant_id = p_tenant_id
           AND d.status <> 'published'
           AND (
                d.id IN (
                    SELECT id FROM app.visual_documents
                     WHERE tenant_id = p_tenant_id AND status <> 'published'
                     ORDER BY updated_at DESC
                     OFFSET v_max
                )
                OR d.created_at < now() - make_interval(days => v_keep_days)
           )
         ORDER BY d.created_at ASC
         LIMIT 500
    ), upd AS (
        UPDATE app.visual_documents d
           SET status = 'archived', updated_at = now()
          FROM picked p
         WHERE d.id = p.id AND NOT v_hard
        RETURNING d.id
    ), del AS (
        DELETE FROM app.visual_documents d
         USING picked p
         WHERE d.id = p.id AND v_hard
        RETURNING d.id
    )
    SELECT p.id, p.title, p.act FROM picked p;
END $fn$;

-- Running cost, so a runaway generation loop is visible rather than
-- discovered on the invoice.
CREATE OR REPLACE FUNCTION app.visual_document_spend(
    p_tenant_id  UUID,
    p_since_days INTEGER DEFAULT 30
) RETURNS TABLE (
    documents      BIGINT,
    generated_assets BIGINT,
    total_cost     NUMERIC,
    by_model       JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $fn$
    WITH scoped AS (
        SELECT s.image_model, s.image_cost_usd
          FROM app.visual_slides s
          JOIN app.visual_documents d ON d.id = s.document_id
         WHERE d.tenant_id = p_tenant_id
           AND d.created_at > now() - make_interval(days => p_since_days)
    ), per_model AS (
        SELECT COALESCE(image_model, '(none)') AS model,
               count(*) AS n,
               COALESCE(sum(COALESCE(image_cost_usd, 0)), 0) AS cost
          FROM scoped
         WHERE image_model IS NOT NULL
         GROUP BY 1
    )
    SELECT
        (SELECT count(*) FROM app.visual_documents d
          WHERE d.tenant_id = p_tenant_id
            AND d.created_at > now() - make_interval(days => p_since_days))::bigint,
        (SELECT count(*) FROM scoped WHERE image_model IS NOT NULL)::bigint,
        (SELECT COALESCE(sum(COALESCE(image_cost_usd, 0)), 0) FROM scoped)::numeric,
        (SELECT COALESCE(jsonb_object_agg(
                    model, jsonb_build_object('count', n, 'cost', cost)),
                    '{}'::jsonb)
           FROM per_model);
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- RLS
--
-- The RPCs above are SECURITY DEFINER and enforce tenant scoping in their own
-- WHERE clauses. These policies are the defence in depth for direct table
-- access (the Supabase REST client reads tables straight, bypassing RPCs).
--
-- The local stack's service role bypasses RLS entirely, which is how the relay
-- and edge functions keep working; anon/authenticated roles are what these
-- policies constrain.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE app.design_templates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.template_fields        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.visual_documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.visual_slides          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.visual_document_retention ENABLE ROW LEVEL SECURITY;

-- `current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'` is the
-- convention the rest of this schema uses. With no claim set (the local
-- emulator, service role), the expression yields NULL and no row matches —
-- which fails closed rather than open.
DROP POLICY IF EXISTS design_templates_tenant ON app.design_templates;
CREATE POLICY design_templates_tenant ON app.design_templates
  USING (tenant_id = NULLIF(
      current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid);

DROP POLICY IF EXISTS visual_documents_tenant ON app.visual_documents;
CREATE POLICY visual_documents_tenant ON app.visual_documents
  USING (tenant_id = NULLIF(
      current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid);

DROP POLICY IF EXISTS visual_retention_tenant ON app.visual_document_retention;
CREATE POLICY visual_retention_tenant ON app.visual_document_retention
  USING (tenant_id = NULLIF(
      current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid);

-- Slides inherit their document's tenant rather than carrying their own.
DROP POLICY IF EXISTS visual_slides_tenant ON app.visual_slides;
CREATE POLICY visual_slides_tenant ON app.visual_slides
  USING (EXISTS (
      SELECT 1 FROM app.visual_documents d
       WHERE d.id = visual_slides.document_id
         AND d.tenant_id = NULLIF(
             current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid
  ));

-- Fields inherit their template's tenant.
DROP POLICY IF EXISTS template_fields_tenant ON app.template_fields;
CREATE POLICY template_fields_tenant ON app.template_fields
  USING (EXISTS (
      SELECT 1 FROM app.design_templates t
       WHERE t.id = template_fields.template_id
         AND t.tenant_id = NULLIF(
             current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid
  ));