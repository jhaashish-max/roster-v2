-- ============================================================
-- 4. SHIFT LEGENDS (admin-configurable status colors/labels)
-- ============================================================
CREATE TABLE IF NOT EXISTS shift_legends (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id   UUID REFERENCES departments(id) ON DELETE CASCADE,
    status_code     TEXT NOT NULL,
    label           TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#888888',
    text_color      TEXT NOT NULL DEFAULT '#ffffff',
    is_holiday      BOOLEAN NOT NULL DEFAULT FALSE,
    is_off          BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order      INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(department_id, status_code)
);
CREATE INDEX idx_sl_dept ON shift_legends(department_id);

-- RLS
ALTER TABLE shift_legends ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read (needed to render cells)
CREATE POLICY "legends_read" ON shift_legends FOR SELECT USING (true);

-- Only service role manages writes (API layer enforces admin checks)
CREATE POLICY "legends_write" ON shift_legends FOR ALL USING (true) WITH CHECK (true);
