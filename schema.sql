-- ============================================
-- IRREGULAR - Accounts Receivable Tracker
-- Supabase Schema Migration
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── CLIENTS ───
-- All client info from the "Info" sheet
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,                    -- Nome Comercial
  legal_name TEXT,                       -- Nomes Legais
  address TEXT,                          -- Morada / info legal
  invoice_required BOOLEAN DEFAULT false,-- Invoice?
  payment_method TEXT,                   -- wire, crypto, capitalist, etc.
  comments TEXT,                         -- Comentários (URLs, instruções)
  wallets_crypto TEXT,                   -- Wallets Crypto do cliente
  our_wallet TEXT,                       -- Nossa Wallet USDT
  extra_info TEXT,                       -- Info adicional
  currency TEXT DEFAULT 'EUR',           -- Moeda principal (EUR/USD)
  threshold NUMERIC,                     -- Valor mínimo para pagamento
  is_active BOOLEAN DEFAULT true,        -- Cliente ativo ou fechado
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── MONTHLY INVOICES ───
-- Each row = one client + one month
-- This is where you set "this month, client X owes €Y"
CREATE TABLE monthly_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                   -- "Jan 26", "Fev 25", etc.
  revenue NUMERIC,                       -- Valor a faturar (null = pendente)
  currency TEXT DEFAULT 'EUR',           -- Moeda deste registo
  obs TEXT,                              -- Observações
  date_set DATE,                         -- Data em que o valor foi registado (início contagem dias)
  stage TEXT DEFAULT 'confirm',          -- confirm, invoice, request, followup, received
  on_hold NUMERIC DEFAULT 0,            -- Valor em disputa/bloqueado
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, month)              -- Um registo por cliente/mês
);

-- ─── PAYMENTS ───
-- Each payment received (supports partial payments)
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES monthly_invoices(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,               -- Valor recebido
  payment_date DATE NOT NULL,            -- Data de recebimento
  method TEXT,                           -- wire, crypto, capitalist, revolut
  note TEXT,                             -- Hash, referência, comentário
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── NOTES ───
-- Comments per client (not tied to a specific month)
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES monthly_invoices(id) ON DELETE SET NULL, -- optional: tie to specific month
  text TEXT NOT NULL,
  author TEXT NOT NULL,                  -- User initials or name
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── CONTACT LOG ───
-- Track every follow-up attempt for proper follow-up history
CREATE TABLE contact_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES monthly_invoices(id) ON DELETE SET NULL,
  contact_type TEXT NOT NULL,            -- email, telegram, skype, phone, platform
  summary TEXT,                          -- Brief description of what was said/done
  contacted_by TEXT,                     -- Who made contact
  contacted_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

-- ─── INDEXES ───
CREATE INDEX idx_invoices_client ON monthly_invoices(client_id);
CREATE INDEX idx_invoices_month ON monthly_invoices(month);
CREATE INDEX idx_invoices_stage ON monthly_invoices(stage);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_notes_client ON notes(client_id);
CREATE INDEX idx_contact_client ON contact_log(client_id);

-- ─── VIEWS ───

-- View: Client summary with outstanding amounts
CREATE OR REPLACE VIEW client_summary AS
SELECT
  c.id,
  c.name,
  c.payment_method,
  c.currency,
  c.is_active,
  c.threshold,
  COALESCE(SUM(mi.revenue), 0) AS total_revenue,
  COALESCE(SUM(p_totals.paid), 0) AS total_paid,
  COALESCE(SUM(mi.revenue), 0) - COALESCE(SUM(p_totals.paid), 0) AS total_owed,
  COALESCE(SUM(mi.on_hold), 0) AS total_on_hold,
  COUNT(CASE WHEN mi.revenue > 0 AND COALESCE(p_totals.paid, 0) < mi.revenue - 0.01 THEN 1 END) AS overdue_count,
  MAX(CASE
    WHEN mi.revenue > 0 AND COALESCE(p_totals.paid, 0) < mi.revenue - 0.01 AND mi.date_set IS NOT NULL
    THEN CURRENT_DATE - mi.date_set
  END) AS max_days_overdue
FROM clients c
LEFT JOIN monthly_invoices mi ON mi.client_id = c.id
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid
  FROM payments
  GROUP BY invoice_id
) p_totals ON p_totals.invoice_id = mi.id
GROUP BY c.id, c.name, c.payment_method, c.currency, c.is_active, c.threshold;

-- View: Aging report buckets
CREATE OR REPLACE VIEW aging_report AS
SELECT
  c.name AS client_name,
  mi.month,
  mi.revenue,
  COALESCE(p_totals.paid, 0) AS paid,
  mi.revenue - COALESCE(p_totals.paid, 0) AS owed,
  mi.currency,
  CURRENT_DATE - mi.date_set AS days,
  CASE
    WHEN CURRENT_DATE - mi.date_set <= 7 THEN '0-7'
    WHEN CURRENT_DATE - mi.date_set <= 15 THEN '8-15'
    WHEN CURRENT_DATE - mi.date_set <= 30 THEN '16-30'
    ELSE '30+'
  END AS bucket
FROM monthly_invoices mi
JOIN clients c ON c.id = mi.client_id
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid
  FROM payments
  GROUP BY invoice_id
) p_totals ON p_totals.invoice_id = mi.id
WHERE mi.revenue > 0
  AND mi.date_set IS NOT NULL
  AND COALESCE(p_totals.paid, 0) < mi.revenue - 0.01;

-- View: Actions queue (pending tasks)
CREATE OR REPLACE VIEW action_queue AS
SELECT
  c.name AS client_name,
  c.id AS client_id,
  mi.id AS invoice_id,
  mi.month,
  mi.revenue,
  mi.currency,
  mi.stage,
  mi.date_set,
  CASE WHEN mi.date_set IS NOT NULL THEN CURRENT_DATE - mi.date_set ELSE 0 END AS days,
  CASE mi.stage
    WHEN 'confirm' THEN 1
    WHEN 'invoice' THEN 2
    WHEN 'request' THEN 3
    WHEN 'followup' THEN 4
    ELSE 5
  END AS priority
FROM monthly_invoices mi
JOIN clients c ON c.id = mi.client_id
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS paid
  FROM payments
  GROUP BY invoice_id
) p_totals ON p_totals.invoice_id = mi.id
WHERE mi.revenue > 0
  AND COALESCE(p_totals.paid, 0) < mi.revenue - 0.01
  AND mi.stage != 'received'
ORDER BY priority, days DESC;

-- ─── ROW LEVEL SECURITY ───
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_log ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users full access (2-person team)
CREATE POLICY "Authenticated users full access" ON clients FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users full access" ON monthly_invoices FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users full access" ON payments FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users full access" ON notes FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users full access" ON contact_log FOR ALL USING (auth.role() = 'authenticated');

-- ─── TRIGGERS ───
-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_updated BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_modified_column();
CREATE TRIGGER invoices_updated BEFORE UPDATE ON monthly_invoices FOR EACH ROW EXECUTE FUNCTION update_modified_column();
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION update_modified_column();
CREATE TRIGGER notes_updated BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION update_modified_column();
