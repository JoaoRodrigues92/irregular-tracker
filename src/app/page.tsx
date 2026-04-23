'use client'
export const dynamic = 'force-dynamic'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

const TODAY = new Date().toISOString().slice(0, 10)

const STAGES = [
  { id: 'confirm', label: 'Confirmar', icon: '🔍', color: '#6b7280' },
  { id: 'invoice', label: 'Fatura', icon: '📄', color: '#8b5cf6' },
  { id: 'request', label: 'Pedido', icon: '📨', color: '#3b82f6' },
  { id: 'followup', label: 'Follow-up', icon: '🔔', color: '#f59e0b' },
  { id: 'received', label: 'Recebido', icon: '✓', color: '#22c55e' },
]

const SM: Record<string, { l: string; c: string; b: string }> = {
  paid: { l: 'Pago', c: '#22c55e', b: 'rgba(34,197,94,0.12)' },
  partial: { l: 'Parcial', c: '#f59e0b', b: 'rgba(245,158,11,0.12)' },
  unpaid: { l: 'Por Cobrar', c: '#ef4444', b: 'rgba(239,68,68,0.12)' },
  pending: { l: 'Pendente', c: '#6b7280', b: 'rgba(107,114,128,0.08)' },
  zero: { l: '€0', c: '#6b7280', b: 'rgba(107,114,128,0.06)' },
  writeoff: { l: 'Incobrável', c: '#9333ea', b: 'rgba(147,51,234,0.12)' },
}

function daysB(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000)
}

function fmt(v: number | null | undefined, c: string) {
  if (v == null) return '—'
  const sym = c === 'USD' ? '$' : '€'
  const parts = Math.abs(v).toFixed(2).split('.')
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const decPart = parts[1]
  return (v < 0 ? '-' : '') + sym + intPart + ',' + decPart
}

function calcSt(revenue: number | null, totalPaid: number, badDebt: number = 0): string {
  if (revenue == null) return 'pending'
  if (revenue === 0) return 'zero'
  const covered = totalPaid + badDebt
  if (covered >= revenue - 0.01) {
    return badDebt > 0 && totalPaid < revenue - 0.01 ? 'writeoff' : 'paid'
  }
  if (totalPaid <= 0 && badDebt <= 0) return 'unpaid'
  return 'partial'
}

const iBase: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.08)', background: '#0c0e14',
  color: '#e8eaf0', fontSize: 13, outline: 'none',
}
const lbl: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase',
  display: 'block', marginBottom: 3, letterSpacing: 0.5,
}

interface Client {
  id: string; name: string; legal_name: string | null; currency: string;
  payment_method: string | null; requires_invoice: boolean;
  threshold: number | null; is_active: boolean; comments: string | null;
  wallet_crypto: string | null; our_wallet: string | null;
  address: string | null; extra_info: string | null;
}
interface Invoice {
  id: string; client_id: string; month: string; month_index: number;
  revenue: number | null; currency: string; on_hold: number;
  bad_debt: number; obs: string | null; date_set: string | null; stage: string;
}
interface Payment {
  id: string; invoice_id: string; amount: number;
  payment_date: string; method: string | null; note: string | null;
}
interface Note {
  id: string; client_id: string; invoice_id: string | null;
  text: string; author_initials: string; created_at: string;
}

function Badge({ status }: { status: string }) {
  const s = SM[status] || SM.pending
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 5, fontSize: 9, fontWeight: 600, color: s.c, background: s.b, textTransform: 'uppercase' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.c }} />
      {s.l}
    </span>
  )
}

function StagePill({ stage, onAdv, onBack }: { stage: string; onAdv?: (s: string) => void; onBack?: (s: string) => void }) {
  const s = STAGES.find(x => x.id === stage) || STAGES[0]
  const idx = STAGES.findIndex(x => x.id === stage)
  const next = idx < STAGES.length - 1 ? STAGES[idx + 1] : null
  const prev = idx > 0 ? STAGES[idx - 1] : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {prev && onBack && (
        <button onClick={e => { e.stopPropagation(); onBack(prev.id) }}
          style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: '#6b7185', cursor: 'pointer', fontSize: 10, padding: '1px 5px' }}>←</button>
      )}
      <span style={{ fontSize: 10, fontWeight: 600, color: s.color, padding: '2px 8px', borderRadius: 5, background: s.color + '18' }}>
        {s.icon} {s.label}
      </span>
      {next && onAdv && (
        <button onClick={e => { e.stopPropagation(); onAdv(next.id) }}
          style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: '#6b7185', cursor: 'pointer', fontSize: 10, padding: '1px 5px' }}>→</button>
      )}
    </div>
  )
}

// ════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════
export default function Tracker() {
  const [clients, setClients] = useState<Client[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showAging, setShowAging] = useState(false)
  const [showAddClient, setShowAddClient] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    const [cR, iR, pR, nR] = await Promise.all([
      supabase.from('clients').select('*').order('name'),
      supabase.from('invoices').select('*').gt('month_index', 202600).order('month_index').limit(5000),
      supabase.from('payments').select('*').limit(5000),
      supabase.from('notes').select('*').order('created_at', { ascending: false }).limit(5000),
    ])
    if (cR.data) setClients(cR.data)
    if (iR.data) setInvoices(iR.data)
    if (pR.data) setPayments(pR.data)
    if (nR.data) setNotes(nR.data)
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const enriched = useMemo(() => {
    return clients.map(c => {
      const cI = invoices.filter(i => i.client_id === c.id)
      let tR = 0, tP = 0, ho = false, mD = 0, tH = 0, tBD = 0
      cI.forEach(inv => {
        tR += inv.revenue || 0
        tH += inv.on_hold || 0
        tBD += inv.bad_debt || 0
        const pd = payments.filter(p => p.invoice_id === inv.id).reduce((s, p) => s + p.amount, 0)
        tP += pd
        const st = calcSt(inv.revenue, pd, inv.bad_debt || 0)
        if (st === 'unpaid' || st === 'partial') {
          ho = true
          if (inv.date_set) { const d = daysB(inv.date_set, TODAY); if (d > mD) mD = d }
        }
      })
      return { ...c, totalRev: tR, totalPaid: tP, totalOwed: tR - tP - tBD, hasOverdue: ho, maxDays: mD, totalHold: tH, totalBadDebt: tBD, invoiceCount: cI.length }
    })
  }, [clients, invoices, payments])

  const kpis = useMemo(() => {
    let r = 0, p = 0, oc = 0, h = 0, bd = 0
    enriched.forEach(c => { r += c.totalRev; p += c.totalPaid; if (c.hasOverdue) oc++; h += c.totalHold; bd += c.totalBadDebt })
    return { r, p, o: r - p - bd, oc, h, bd }
  }, [enriched])

  const filtered = useMemo(() => {
    let l = enriched.filter(c => c.is_active && c.invoiceCount > 0)
    if (search) l = l.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    if (filter === 'overdue') l = l.filter(c => c.hasOverdue)
    if (filter === 'paid') l = l.filter(c => !c.hasOverdue)
    return l.sort((a, b) => b.maxDays - a.maxDays || b.totalOwed - a.totalOwed)
  }, [enriched, search, filter])

  const actions = useMemo(() => {
    const list: any[] = []
    clients.forEach(c => {
      invoices.filter(i => i.client_id === c.id).forEach(inv => {
        if (!inv.revenue || inv.revenue === 0) return
        const pd = payments.filter(p => p.invoice_id === inv.id).reduce((s, p) => s + p.amount, 0)
        const bd = inv.bad_debt || 0
        if (pd + bd >= (inv.revenue || 0) - 0.01) return
        const days = inv.date_set ? daysB(inv.date_set, TODAY) : 0
        const map: any = { confirm: { action: 'Confirmar nºs', icon: '🔍', pri: 1 }, invoice: { action: 'Enviar fatura', icon: '📄', pri: 2 }, request: { action: 'Pedir pagamento', icon: '📨', pri: 3 } }
        if (map[inv.stage]) list.push({ client: c.name, month: inv.month, cur: c.currency, amt: inv.revenue!, days, ...map[inv.stage] })
        else if (inv.stage === 'followup' && days > 5) list.push({ client: c.name, month: inv.month, cur: c.currency, amt: inv.revenue!, days, action: `Follow-up (${days}d)`, icon: '🔔', pri: 4 })
      })
    })
    return list.sort((a: any, b: any) => a.pri - b.pri || b.days - a.days).slice(0, 8)
  }, [clients, invoices, payments])

  // Mutations
  const updateInvoice = async (id: string, data: any) => { await supabase.from('invoices').update(data).eq('id', id); loadData() }
  const deleteInvoice = async (id: string) => { await supabase.from('invoices').delete().eq('id', id); loadData() }
  const addPayment = async (iid: string, data: any) => { await supabase.from('payments').insert({ invoice_id: iid, ...data }); loadData() }
  const editPayment = async (id: string, data: any) => { await supabase.from('payments').update(data).eq('id', id); loadData() }
  const deletePayment = async (id: string) => { await supabase.from('payments').delete().eq('id', id); loadData() }
  const addNote = async (cid: string, text: string) => { await supabase.from('notes').insert({ client_id: cid, text, author_initials: 'JA' }); loadData() }
  const editNote = async (id: string, text: string) => { await supabase.from('notes').update({ text }).eq('id', id); loadData() }
  const deleteNote = async (id: string) => { await supabase.from('notes').delete().eq('id', id); loadData() }
  const addInvoice = async (cid: string, m: string, mi: number, r: number | null, o: string, d: string | null) => {
    await supabase.from('invoices').insert({ client_id: cid, month: m, month_index: mi, revenue: r, obs: o, date_set: d, stage: 'confirm', on_hold: 0, bad_debt: 0, currency: clients.find(c => c.id === cid)?.currency || 'EUR' })
    loadData()
  }
  const addClient = async (data: any) => { const res = await supabase.from('clients').insert(data).select(); loadData(); if (res.data?.[0]) setSelId(res.data[0].id) }
  const updateClient = async (id: string, data: any) => { await supabase.from('clients').update(data).eq('id', id); loadData() }

  const selectedClient = clients.find(c => c.id === selId)
  const selectedInvoices = invoices.filter(i => i.client_id === selId).sort((a, b) => a.month_index - b.month_index)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: '#6366f1', transform: 'rotate(45deg)', margin: '0 auto 12px' }} />
          <div style={{ fontSize: 14, color: '#6b7185' }}>A carregar...</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1060, margin: '0 auto', padding: '20px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: '#6366f1', transform: 'rotate(45deg)' }} />
            <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.5, margin: 0 }}>Irregular</h1>
            <span style={{ fontSize: 10, fontWeight: 600, color: '#6366f1', padding: '2px 8px', borderRadius: 4, background: 'rgba(99,102,241,0.1)' }}>2026</span>
          </div>
          <p style={{ fontSize: 11, color: '#6b7185', margin: 0 }}>Accounts Receivable Tracker · {filtered.length} clientes</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => { setShowAddClient(!showAddClient); setShowAging(false) }} style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(34,197,94,0.3)', background: showAddClient ? '#22c55e' : 'rgba(34,197,94,0.08)', color: showAddClient ? '#fff' : '#22c55e' }}>+ Cliente</button>
          <button onClick={() => { setShowAging(!showAging); setShowAddClient(false) }} style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: showAging ? '#6366f1' : 'transparent', color: showAging ? '#fff' : '#6b7185' }}>Aging</button>
        </div>
      </div>

      {showAddClient && <AddClientForm onAdd={d => { addClient(d); setShowAddClient(false) }} onCancel={() => setShowAddClient(false)} />}

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { l: 'Faturado', v: fmt(kpis.r, 'EUR'), a: '#6366f1' },
          { l: 'Recebido', v: fmt(kpis.p, 'EUR'), a: '#22c55e' },
          { l: 'Em Aberto', v: fmt(kpis.o, 'EUR'), a: '#ef4444' },
          { l: 'Incobrável', v: fmt(kpis.bd, 'EUR'), a: '#9333ea' },
          { l: 'C/ Atraso', v: String(kpis.oc), a: '#f59e0b' },
        ].map((k, i) => (
          <div key={i} style={{ flex: 1, minWidth: 100, padding: '13px 14px', borderRadius: 10, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: k.a }} />
            <div style={{ fontSize: 8, color: '#6b7185', fontWeight: 600, textTransform: 'uppercase', marginBottom: 3 }}>{k.l}</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>⚡ Ações Pendentes</div>
          {actions.map((a: any, i: number) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 7, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', marginBottom: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>{a.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{a.client}</span>
                <span style={{ fontSize: 10, color: '#6b7185' }}>{a.month}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: '#a5b4fc', fontFamily: "'DM Mono', monospace" }}>{fmt(a.amt, a.cur)}</span>
                <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>{a.action}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Aging */}
      {showAging && (
        <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#a5b4fc', textTransform: 'uppercase', marginBottom: 10 }}>Aging Report</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[{ min: 31, max: 9999, label: '30+', color: '#ef4444' }, { min: 16, max: 30, label: '16-30', color: '#f97316' }, { min: 8, max: 15, label: '8-15', color: '#f59e0b' }, { min: 0, max: 7, label: '0-7', color: '#22c55e' }].map(cfg => {
              let count = 0, total = 0
              invoices.forEach(inv => {
                if (!inv.date_set || !inv.revenue || inv.revenue <= 0) return
                const pd = payments.filter(p => p.invoice_id === inv.id).reduce((s, p) => s + p.amount, 0)
                const bd = inv.bad_debt || 0
                if (pd + bd >= inv.revenue - 0.01) return
                const d = daysB(inv.date_set, TODAY)
                if (d >= cfg.min && d <= cfg.max) { count++; total += inv.revenue - pd - bd }
              })
              return (
                <div key={cfg.label} style={{ flex: 1, minWidth: 120, padding: '10px 12px', borderRadius: 9, background: cfg.color + '0A', border: '1px solid ' + cfg.color + '20' }}>
                  <div style={{ fontSize: 9, fontWeight: 600, color: cfg.color, textTransform: 'uppercase', marginBottom: 4 }}>{cfg.label} dias</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: cfg.color, fontFamily: "'DM Mono', monospace" }}>{count > 0 ? fmt(total, 'EUR') : '—'}</div>
                  <div style={{ fontSize: 9, color: '#6b7185', marginTop: 2 }}>{count} registo{count !== 1 ? 's' : ''}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Client List */}
      <div style={{ background: '#12151e', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar..." style={{ padding: '6px 10px', borderRadius: 6, width: 200, fontSize: 11, outline: 'none', border: '1px solid rgba(255,255,255,0.08)', background: '#0c0e14', color: '#e8eaf0' }} />
          <div style={{ display: 'flex', gap: 3 }}>
            {[['all', 'Todos'], ['overdue', 'Em atraso'], ['paid', 'Em dia']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: filter === k ? '#6366f1' : 'transparent', color: filter === k ? '#fff' : '#6b7185' }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 75px 55px 55px', padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 8, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' }}>
          <span>Cliente</span><span style={{ textAlign: 'right' }}>Em Aberto</span><span style={{ textAlign: 'center' }}>Estado</span><span style={{ textAlign: 'center' }}>Dias</span><span style={{ textAlign: 'center' }}>Moeda</span>
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {filtered.map(c => {
            const cI = invoices.filter(i => i.client_id === c.id)
            const li = [...cI].reverse().find(i => (i.revenue || 0) > 0)
            const lp = li ? payments.filter(p => p.invoice_id === li.id).reduce((s, p) => s + p.amount, 0) : 0
            const lb = li ? (li.bad_debt || 0) : 0
            const ls = li ? calcSt(li.revenue, lp, lb) : 'pending'
            return (
              <div key={c.id} onClick={() => setSelId(c.id)}
                style={{ display: 'grid', gridTemplateColumns: '1fr 100px 75px 55px 55px', alignItems: 'center', padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.03)', background: selId === c.id ? 'rgba(99,102,241,0.08)' : 'transparent', transition: 'background .1s' }}
                onMouseEnter={e => { if (selId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'rgba(99,102,241,0.04)' }}
                onMouseLeave={e => { if (selId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                    {c.name}
                    {c.hasOverdue && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444' }} />}
                    {c.totalBadDebt > 0 && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#9333ea' }} />}
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7185', marginTop: 1 }}>{c.payment_method || '—'}</div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: c.totalOwed > 0.01 ? '#ef4444' : '#22c55e' }}>
                  {c.totalOwed > 0.01 ? fmt(c.totalOwed, c.currency) : '✓'}
                </div>
                <div style={{ textAlign: 'center' }}><Badge status={ls} /></div>
                <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: c.maxDays > 20 ? '#ef4444' : c.maxDays > 7 ? '#f59e0b' : '#6b7185' }}>
                  {c.hasOverdue && c.maxDays > 0 ? c.maxDays + 'd' : '—'}
                </div>
                <div style={{ fontSize: 9, color: '#6b7185', textAlign: 'center' }}>{c.currency}</div>
              </div>
            )
          })}
        </div>
      </div>

      {selectedClient && (
        <ClientPanel
          client={selectedClient} invoices={selectedInvoices} payments={payments}
          notes={notes.filter(n => n.client_id === selectedClient.id)}
          onClose={() => setSelId(null)} onUpdateInvoice={updateInvoice} onDeleteInvoice={deleteInvoice}
          onAddPayment={addPayment} onEditPayment={editPayment} onDeletePayment={deletePayment}
          onAddNote={addNote} onEditNote={editNote} onDeleteNote={deleteNote}
          onAddInvoice={addInvoice} onUpdateClient={updateClient}
        />
      )}
    </div>
  )
}

// ════════════════════════════════════════
// CLIENT PANEL
// ════════════════════════════════════════
function ClientPanel({ client, invoices, payments, notes, onClose, onUpdateInvoice, onDeleteInvoice, onAddPayment, onEditPayment, onDeletePayment, onAddNote, onEditNote, onDeleteNote, onAddInvoice, onUpdateClient }: {
  client: Client; invoices: Invoice[]; payments: Payment[]; notes: Note[];
  onClose: () => void; onUpdateInvoice: (id: string, d: any) => void; onDeleteInvoice: (id: string) => void;
  onAddPayment: (id: string, d: any) => void; onEditPayment: (id: string, d: any) => void; onDeletePayment: (id: string) => void;
  onAddNote: (id: string, t: string) => void; onEditNote: (id: string, t: string) => void; onDeleteNote: (id: string) => void;
  onAddInvoice: (c: string, m: string, mi: number, r: number | null, o: string, d: string | null) => void;
  onUpdateClient: (id: string, d: Partial<Client>) => void;
}) {
  const [editId, setEditId] = useState<string | null>(null)
  const [payId, setPayId] = useState<string | null>(null)
  const [editPayId, setEditPayId] = useState<string | null>(null)
  const [editNoteId, setEditNoteId] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [showEditClient, setShowEditClient] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [showAddMonth, setShowAddMonth] = useState(false)

  const totals = useMemo(() => {
    let r = 0, p = 0, h = 0, bd = 0
    invoices.forEach(inv => {
      r += inv.revenue || 0; h += inv.on_hold || 0; bd += inv.bad_debt || 0
      p += payments.filter(py => py.invoice_id === inv.id).reduce((s, py) => s + py.amount, 0)
    })
    return { r, p, o: r - p - bd, h, bd }
  }, [invoices, payments])

  const clear = () => { setEditId(null); setPayId(null); setEditPayId(null); setShowAddMonth(false) }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 99 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 93vw)', background: '#0c0e14', borderLeft: '1px solid rgba(255,255,255,0.06)', zIndex: 100, overflowY: 'auto', boxShadow: '-10px 0 40px rgba(0,0,0,0.4)' }}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: '#0c0e14', zIndex: 2 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{client.name}</h2>
            <span style={{ fontSize: 11, color: '#6b7185' }}>{client.payment_method || '—'} · {client.currency}{client.requires_invoice ? ' · Fatura' : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setShowEditClient(!showEditClient)} style={{ background: '#12151e', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, color: showEditClient ? '#6366f1' : '#6b7185', padding: '5px 10px', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>Ficha</button>
            <button onClick={onClose} style={{ background: '#12151e', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, color: '#e8eaf0', padding: '5px 12px', cursor: 'pointer' }}>✕</button>
          </div>
        </div>

        {showEditClient && <EditClientForm client={client} onSave={d => { onUpdateClient(client.id, d); setShowEditClient(false) }} onCancel={() => setShowEditClient(false)} />}

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 6, padding: '12px 20px', flexWrap: 'wrap' }}>
          {[
            { l: 'Faturado', v: fmt(totals.r, client.currency), c: '#a5b4fc' },
            { l: 'Recebido', v: fmt(totals.p, client.currency), c: '#22c55e' },
            { l: 'Em Aberto', v: fmt(totals.o, client.currency), c: totals.o > 0 ? '#ef4444' : '#22c55e' },
            ...(totals.bd > 0 ? [{ l: 'Incobrável', v: fmt(totals.bd, client.currency), c: '#9333ea' }] : []),
            ...(totals.h > 0 ? [{ l: 'On Hold', v: fmt(totals.h, client.currency), c: '#f97316' }] : []),
          ].map((k, i) => (
            <div key={i} style={{ flex: 1, minWidth: 80, padding: '9px 11px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 8, color: k.c, fontWeight: 600, textTransform: 'uppercase' as const }}>{k.l}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: k.c, fontFamily: "'DM Mono', monospace", marginTop: 2 }}>{k.v}</div>
            </div>
          ))}
        </div>

        {/* Client Info */}
        {!showEditClient && (client.legal_name || client.comments || client.address || client.wallet_crypto) && (
          <div style={{ padding: '0 20px 8px' }}>
            <div style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.07)', fontSize: 10, color: '#a5b4fc', lineHeight: 1.6 }}>
              {client.legal_name && <div><strong>Legal:</strong> {client.legal_name}</div>}
              {client.address && <div><strong>Morada:</strong> {client.address}</div>}
              {client.wallet_crypto && <div><strong>Wallet:</strong> <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9 }}>{client.wallet_crypto}</span></div>}
              {client.our_wallet && <div><strong>Nossa wallet:</strong> <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9 }}>{client.our_wallet}</span></div>}
              {client.comments && <div style={{ marginTop: 4 }}>{client.comments}</div>}
              {client.extra_info && <div style={{ marginTop: 2, color: '#6b7185' }}>{client.extra_info}</div>}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div style={{ padding: '0 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ fontSize: 11, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, margin: 0 }}>Timeline ({invoices.length})</h3>
            {!showAddMonth && (
              <button onClick={() => { clear(); setShowAddMonth(true) }} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)', color: '#22c55e' }}>+ Mês</button>
            )}
          </div>

          {showAddMonth && (
            <AddMonthForm
              onAdd={(m, mi, r, o, d) => { onAddInvoice(client.id, m, mi, r, o, d); setShowAddMonth(false) }}
              onCancel={() => setShowAddMonth(false)}
            />
          )}

          {invoices.map(inv => {
            const ip = payments.filter(p => p.invoice_id === inv.id)
            const pd = ip.reduce((s, p) => s + p.amount, 0)
            const bd = inv.bad_debt || 0
            const st = calcSt(inv.revenue, pd, bd)
            const rem = (inv.revenue || 0) - pd - bd
            const days = inv.date_set && inv.revenue && inv.revenue > 0 ? daysB(inv.date_set, TODAY) : null
            const resolved = st === 'paid' || st === 'writeoff'
            const resDays = st === 'paid' && inv.date_set && ip.length > 0
              ? daysB(inv.date_set, ip.reduce((l, p) => p.payment_date > l ? p.payment_date : l, ''))
              : null

            return (
              <div key={inv.id} style={{ marginBottom: 6, borderRadius: 9, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ padding: '11px 13px' }}>
                  {/* Month Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{inv.month}</span>
                      <button onClick={() => setConfirmDel('inv-' + inv.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, opacity: 0.3, padding: 0 }}>🗑️</button>
                      {!resolved && days != null && days > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: days > 20 ? '#ef4444' : days > 7 ? '#f59e0b' : '#6b7185', background: (days > 20 ? '#ef4444' : days > 7 ? '#f59e0b' : '#6b7280') + '15' }}>⏱ {days}d</span>
                      )}
                      {resDays != null && <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: '#22c55e', background: 'rgba(34,197,94,0.1)' }}>✓ {resDays}d</span>}
                      {bd > 0 && <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: '#9333ea', background: 'rgba(147,51,234,0.1)' }}>💀 {fmt(bd, client.currency)}</span>}
                      {inv.on_hold > 0 && <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: '#f97316', background: 'rgba(249,115,22,0.1)' }}>🔒 {fmt(inv.on_hold, client.currency)}</span>}
                    </div>
                    <StagePill stage={inv.stage}
                      onAdv={ns => onUpdateInvoice(inv.id, { stage: ns })}
                      onBack={ns => onUpdateInvoice(inv.id, { stage: ns })} />
                  </div>

                  {/* Delete Invoice Confirmation */}
                  {confirmDel === 'inv-' + inv.id && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: '#ef4444' }}>Apagar este mês e pagamentos?</span>
                      <button onClick={() => { onDeleteInvoice(inv.id); setConfirmDel(null) }}
                        style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 600, cursor: 'pointer' }}>Sim</button>
                      <button onClick={() => setConfirmDel(null)}
                        style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#6b7185', fontSize: 9, cursor: 'pointer' }}>Não</button>
                    </div>
                  )}

                  {/* Numbers */}
                  <div style={{ display: 'grid', gridTemplateColumns: bd > 0 ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr', gap: 5, marginBottom: 6 }}>
                    <div>
                      <div style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 1 }}>Faturado</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: inv.revenue != null ? '#e8eaf0' : '#6b7185' }}>
                          {inv.revenue != null ? fmt(inv.revenue, client.currency) : '—'}
                        </span>
                        <button onClick={() => { clear(); setEditId(editId === inv.id ? null : inv.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, padding: 0, opacity: 0.5 }}>✏️</button>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 1 }}>Recebido</div>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: pd > 0 ? '#22c55e' : '#6b7185' }}>{fmt(pd, client.currency)}</span>
                    </div>
                    {bd > 0 && (
                      <div>
                        <div style={{ fontSize: 8, color: '#9333ea', textTransform: 'uppercase' as const, marginBottom: 1 }}>Incobrável</div>
                        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: '#9333ea' }}>{fmt(bd, client.currency)}</span>
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 1 }}>Em falta</div>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: rem > 0.01 ? '#ef4444' : '#6b7185' }}>{rem > 0.01 ? fmt(rem, client.currency) : '—'}</span>
                    </div>
                  </div>

                  {/* Edit Revenue */}
                  {editId === inv.id && (
                    <EditRevForm invoice={inv} currency={client.currency}
                      onSave={d => { onUpdateInvoice(inv.id, d); setEditId(null) }}
                      onCancel={() => setEditId(null)} />
                  )}

                  {/* Payments */}
                  {ip.length > 0 && editId !== inv.id && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 8, color: '#6b7185', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 3 }}>Pagamentos ({ip.length})</div>
                      {ip.map(p => {
                        if (editPayId === p.id) {
                          return <EditPayInline key={p.id} pay={p} currency={client.currency}
                            onSave={d => { onEditPayment(p.id, d); setEditPayId(null) }}
                            onCancel={() => setEditPayId(null)} />
                        }
                        return (
                          <div key={p.id}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 7px', borderRadius: 4, background: 'rgba(34,197,94,0.03)', marginBottom: 2, alignItems: 'center' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#22c55e', fontFamily: "'DM Mono', monospace" }}>{fmt(p.amount, client.currency)}</span>
                                {p.note && <span style={{ fontSize: 9, color: '#6b7185' }}>{p.note}</span>}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ fontSize: 10 }}>{new Date(p.payment_date).toLocaleDateString('pt-PT')}</span>
                                <span style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const }}>{p.method}</span>
                                <button onClick={() => { clear(); setEditPayId(p.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, opacity: 0.5, padding: 0 }}>✏️</button>
                                <button onClick={() => setConfirmDel(confirmDel === p.id ? null : p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, opacity: 0.5, padding: 0 }}>🗑️</button>
                              </div>
                            </div>
                            {confirmDel === p.id && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, padding: '4px 7px', marginBottom: 3 }}>
                                <span style={{ fontSize: 10, color: '#ef4444' }}>Apagar?</span>
                                <button onClick={() => { onDeletePayment(p.id); setConfirmDel(null) }} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 600, cursor: 'pointer' }}>Sim</button>
                                <button onClick={() => setConfirmDel(null)} style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#6b7185', fontSize: 9, cursor: 'pointer' }}>Não</button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {inv.obs && editId !== inv.id && (
                    <div style={{ padding: '5px 8px', borderRadius: 4, fontSize: 10, color: '#a5b4fc', background: 'rgba(99,102,241,0.04)', marginBottom: 4, lineHeight: 1.4 }}>{inv.obs}</div>
                  )}

                  {inv.revenue != null && inv.revenue > 0 && rem > 0.01 && editId !== inv.id && payId !== inv.id && (
                    <button onClick={() => { clear(); setPayId(inv.id) }}
                      style={{ width: '100%', padding: 7, borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(99,102,241,0.25)', background: 'transparent', color: '#6366f1' }}>+ Registar Pagamento</button>
                  )}

                  {payId === inv.id && (
                    <PayFormInline invoiceId={inv.id} revenue={inv.revenue!} currency={client.currency} payments={ip} badDebt={bd}
                      onAdd={d => { onAddPayment(inv.id, d); setPayId(null) }}
                      onClose={() => setPayId(null)} />
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Notes */}
        <div style={{ padding: '12px 20px 24px' }}>
          <h3 style={{ fontSize: 11, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, margin: 0, marginBottom: 6 }}>Notas ({notes.length})</h3>
          {notes.map(n => {
            if (editNoteId === n.id) {
              return <EditNoteInline key={n.id} note={n} onSave={t => { onEditNote(n.id, t); setEditNoteId(null) }} onCancel={() => setEditNoteId(null)} />
            }
            return (
              <div key={n.id} style={{ padding: '7px 9px', marginBottom: 3, borderRadius: 6, background: '#12151e', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#6366f1', padding: '0 4px', borderRadius: 3, background: 'rgba(99,102,241,0.1)' }}>{n.author_initials}</span>
                    <span style={{ fontSize: 9, color: '#6b7185' }}>{new Date(n.created_at).toLocaleDateString('pt-PT')}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => setEditNoteId(n.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, opacity: 0.5, padding: 0 }}>✏️</button>
                    <button onClick={() => setConfirmDel(confirmDel === n.id ? null : n.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, opacity: 0.5, padding: 0 }}>🗑️</button>
                  </div>
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.4 }}>{n.text}</div>
                {confirmDel === n.id && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: '#ef4444' }}>Apagar?</span>
                    <button onClick={() => { onDeleteNote(n.id); setConfirmDel(null) }} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 600, cursor: 'pointer' }}>Sim</button>
                    <button onClick={() => setConfirmDel(null)} style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#6b7185', fontSize: 9, cursor: 'pointer' }}>Não</button>
                  </div>
                )}
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
            <input value={newNote} onChange={e => setNewNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newNote.trim()) { onAddNote(client.id, newNote); setNewNote('') } }}
              placeholder="Nova nota..." style={{ flex: 1, ...iBase, fontSize: 11, padding: '8px 10px', borderRadius: 6 }} />
            <button onClick={() => { if (newNote.trim()) { onAddNote(client.id, newNote); setNewNote('') } }}
              style={{ padding: '8px 12px', borderRadius: 6, border: 'none', background: '#6366f1', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>+</button>
          </div>
        </div>
      </div>
    </>
  )
}

// ════════════════════════════════════════
// INLINE FORMS
// ════════════════════════════════════════
function EditRevForm({ invoice, currency, onSave, onCancel }: { invoice: Invoice; currency: string; onSave: (d: any) => void; onCancel: () => void }) {
  const [val, setVal] = useState(invoice.revenue != null ? String(invoice.revenue) : '')
  const [obs, setObs] = useState(invoice.obs || '')
  const [ds, setDs] = useState(invoice.date_set || TODAY)
  const [oh, setOh] = useState(String(invoice.on_hold || 0))
  const [bd, setBd] = useState(String(invoice.bad_debt || 0))

  return (
    <div style={{ padding: 14, borderRadius: 9, marginTop: 6, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc' }}>{invoice.revenue != null ? 'Editar Valor' : 'Definir Valor'}</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={lbl}>Valor ({currency})</label>
          <input value={val} onChange={e => setVal(e.target.value)} type="number" step="0.01" autoFocus style={{ ...iBase, fontFamily: "'DM Mono', monospace" }} />
        </div>
        <div>
          <label style={lbl}>Data registo</label>
          <input value={ds} onChange={e => setDs(e.target.value)} type="date" style={iBase} />
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={lbl}>Obs</label>
        <input value={obs} onChange={e => setObs(e.target.value)} style={iBase} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div>
          <label style={{ ...lbl, color: '#9333ea' }}>💀 Incobrável ({currency})</label>
          <input value={bd} onChange={e => setBd(e.target.value)} type="number" step="0.01" placeholder="0" style={{ ...iBase, color: '#9333ea', borderColor: 'rgba(147,51,234,0.2)' }} />
        </div>
        <div>
          <label style={{ ...lbl, color: '#f97316' }}>🔒 On Hold ({currency})</label>
          <input value={oh} onChange={e => setOh(e.target.value)} type="number" step="0.01" style={{ ...iBase, color: '#f97316' }} />
        </div>
      </div>
      <button onClick={() => {
        const n = val === '' ? null : parseFloat(val)
        if (val !== '' && isNaN(n!)) return
        onSave({ revenue: n, obs, date_set: n != null ? ds : null, on_hold: parseFloat(oh) || 0, bad_debt: parseFloat(bd) || 0 })
      }} style={{ width: '100%', padding: 10, borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Guardar</button>
    </div>
  )
}

function PayFormInline({ invoiceId, revenue, currency, payments: ip, badDebt, onAdd, onClose }: {
  invoiceId: string; revenue: number; currency: string; payments: Payment[]; badDebt: number;
  onAdd: (d: any) => void; onClose: () => void;
}) {
  const [amt, setAmt] = useState('')
  const [date, setDate] = useState(TODAY)
  const [meth, setMeth] = useState('wire')
  const [note, setNote] = useState('')
  const ep = ip.reduce((s, p) => s + p.amount, 0)
  const rem = revenue - ep - badDebt
  const pa = parseFloat(amt)
  const ok = !isNaN(pa) && pa >= rem - 0.01

  return (
    <div style={{ padding: 14, borderRadius: 9, marginTop: 6, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc' }}>Registar Pagamento</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={lbl}>Valor ({currency})</label>
          <div style={{ position: 'relative' }}>
            <input value={amt} onChange={e => setAmt(e.target.value)} type="number" step="0.01" style={{ ...iBase, paddingRight: 55, fontFamily: "'DM Mono', monospace" }} />
            <button onClick={() => setAmt(rem.toFixed(2))} style={{ position: 'absolute', right: 4, top: 4, bottom: 4, padding: '0 7px', borderRadius: 5, border: 'none', background: '#6366f1', color: '#fff', fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>TOTAL</button>
          </div>
          <div style={{ fontSize: 9, color: '#6b7185', marginTop: 2 }}>Falta: {fmt(rem, currency)}</div>
        </div>
        <div>
          <label style={lbl}>Data</label>
          <input value={date} onChange={e => setDate(e.target.value)} type="date" style={iBase} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {['wire', 'crypto', 'capitalist', 'revolut'].map(m => (
          <button key={m} onClick={() => setMeth(m)} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 9, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: meth === m ? '#6366f1' : 'transparent', color: meth === m ? '#fff' : '#6b7185' }}>{m}</button>
        ))}
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota..." style={{ ...iBase, marginBottom: 8, fontSize: 11 }} />
      {amt && !isNaN(pa) && (
        <div style={{ padding: '7px 10px', borderRadius: 6, marginBottom: 8, background: ok ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)', border: '1px solid ' + (ok ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)') }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: ok ? '#22c55e' : '#f59e0b' }}>{ok ? 'Cobre totalidade' : 'Parcial — ficam ' + fmt(rem - pa, currency)}</span>
        </div>
      )}
      <button onClick={() => { const v = parseFloat(amt); if (isNaN(v) || v < 0 || !date) return; onAdd({ amount: v, payment_date: date, method: meth, note }) }}
        style={{ width: '100%', padding: 10, borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Confirmar</button>
    </div>
  )
}

function EditPayInline({ pay, currency, onSave, onCancel }: { pay: Payment; currency: string; onSave: (d: any) => void; onCancel: () => void }) {
  const [amt, setAmt] = useState(String(pay.amount))
  const [date, setDate] = useState(pay.payment_date)
  const [meth, setMeth] = useState(pay.method || 'wire')
  const [note, setNote] = useState(pay.note || '')

  return (
    <div style={{ padding: '10px 12px', marginBottom: 3, borderRadius: 6, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#a5b4fc', marginBottom: 8 }}>Editar Pagamento</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <input value={amt} onChange={e => setAmt(e.target.value)} type="number" step="0.01" style={{ ...iBase, fontFamily: "'DM Mono', monospace", fontSize: 12 }} />
        <input value={date} onChange={e => setDate(e.target.value)} type="date" style={{ ...iBase, fontSize: 12 }} />
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {['wire', 'crypto', 'capitalist', 'revolut'].map(m => (
          <button key={m} onClick={() => setMeth(m)} style={{ padding: '3px 9px', borderRadius: 5, fontSize: 9, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: meth === m ? '#6366f1' : 'transparent', color: meth === m ? '#fff' : '#6b7185' }}>{m}</button>
        ))}
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota..." style={{ ...iBase, fontSize: 11, marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#6b7185', fontSize: 10, cursor: 'pointer' }}>Cancelar</button>
        <button onClick={() => { const v = parseFloat(amt); if (isNaN(v)) return; onSave({ amount: v, payment_date: date, method: meth, note }) }}
          style={{ padding: '4px 10px', borderRadius: 5, border: 'none', background: '#6366f1', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>Guardar</button>
      </div>
    </div>
  )
}

function EditNoteInline({ note, onSave, onCancel }: { note: Note; onSave: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(note.text)
  return (
    <div style={{ padding: '8px 10px', marginBottom: 3, borderRadius: 6, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={2} style={{ ...iBase, fontSize: 11, resize: 'vertical' as const, marginBottom: 6 }} />
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#6b7185', fontSize: 10, cursor: 'pointer' }}>Cancelar</button>
        <button onClick={() => onSave(text)} style={{ padding: '4px 10px', borderRadius: 5, border: 'none', background: '#6366f1', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>Guardar</button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════
// ADD/EDIT CLIENT FORMS
// ════════════════════════════════════════
function AddClientForm({ onAdd, onCancel }: { onAdd: (d: any) => void; onCancel: () => void }) {
  const [name, setName] = useState(''); const [ln, setLn] = useState(''); const [cur, setCur] = useState('EUR')
  const [meth, setMeth] = useState(''); const [ri, setRi] = useState(false); const [addr, setAddr] = useState('')
  const [comm, setComm] = useState(''); const [w, setW] = useState(''); const [ow, setOw] = useState('')
  const [ex, setEx] = useState(''); const [th, setTh] = useState('')

  return (
    <div style={{ marginBottom: 16, padding: '18px 20px', borderRadius: 12, background: '#12151e', border: '1px solid rgba(34,197,94,0.2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#22c55e' }}>Novo Cliente</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div><label style={lbl}>Nome *</label><input value={name} onChange={e => setName(e.target.value)} autoFocus style={iBase} /></div>
        <div><label style={lbl}>Nome Legal</label><input value={ln} onChange={e => setLn(e.target.value)} style={iBase} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div><label style={lbl}>Moeda</label><div style={{ display: 'flex', gap: 4 }}>{['EUR', 'USD'].map(c => (<button key={c} onClick={() => setCur(c)} style={{ flex: 1, padding: '8px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: cur === c ? '#6366f1' : 'transparent', color: cur === c ? '#fff' : '#6b7185' }}>{c}</button>))}</div></div>
        <div><label style={lbl}>Método</label><select value={meth} onChange={e => setMeth(e.target.value)} style={{ ...iBase, appearance: 'none' as const }}><option value="">—</option><option value="wire">Wire</option><option value="crypto">Crypto</option><option value="capitalist">Capitalist</option><option value="revolut">Revolut</option></select></div>
        <div><label style={lbl}>Threshold</label><input value={th} onChange={e => setTh(e.target.value)} type="number" step="0.01" style={{ ...iBase, fontFamily: "'DM Mono', monospace" }} /></div>
      </div>
      <div style={{ marginBottom: 10 }}><label style={lbl}>Morada</label><input value={addr} onChange={e => setAddr(e.target.value)} style={iBase} /></div>
      <div style={{ marginBottom: 10 }}><label style={lbl}>Comentários</label><input value={comm} onChange={e => setComm(e.target.value)} style={iBase} /></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div><label style={lbl}>Wallet Crypto</label><input value={w} onChange={e => setW(e.target.value)} style={{ ...iBase, fontFamily: "'DM Mono', monospace", fontSize: 11 }} /></div>
        <div><label style={lbl}>Nossa Wallet</label><input value={ow} onChange={e => setOw(e.target.value)} style={{ ...iBase, fontFamily: "'DM Mono', monospace", fontSize: 11 }} /></div>
      </div>
      <div style={{ marginBottom: 12 }}><label style={lbl}>Info Adicional</label><input value={ex} onChange={e => setEx(e.target.value)} style={iBase} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input type="checkbox" checked={ri} onChange={e => setRi(e.target.checked)} id="ri" style={{ accentColor: '#6366f1' }} />
        <label htmlFor="ri" style={{ fontSize: 12, color: '#e8eaf0', cursor: 'pointer' }}>Requer fatura</label>
      </div>
      <button onClick={() => { if (!name.trim()) return; onAdd({ name: name.trim(), legal_name: ln || null, currency: cur, payment_method: meth || null, requires_invoice: ri, address: addr || null, comments: comm || null, wallet_crypto: w || null, our_wallet: ow || null, extra_info: ex || null, threshold: th ? parseFloat(th) : null, is_active: true }) }}
        style={{ width: '100%', padding: 12, borderRadius: 8, border: 'none', background: '#22c55e', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Criar Cliente</button>
    </div>
  )
}

function EditClientForm({ client, onSave, onCancel }: { client: Client; onSave: (d: any) => void; onCancel: () => void }) {
  const [name, setName] = useState(client.name); const [ln, setLn] = useState(client.legal_name || '')
  const [cur, setCur] = useState(client.currency); const [meth, setMeth] = useState(client.payment_method || '')
  const [ri, setRi] = useState(client.requires_invoice); const [addr, setAddr] = useState(client.address || '')
  const [comm, setComm] = useState(client.comments || ''); const [w, setW] = useState(client.wallet_crypto || '')
  const [ow, setOw] = useState(client.our_wallet || ''); const [ex, setEx] = useState(client.extra_info || '')
  const [th, setTh] = useState(client.threshold ? String(client.threshold) : ''); const [act, setAct] = useState(client.is_active)

  return (
    <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#a5b4fc' }}>Editar Ficha</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div><label style={lbl}>Nome</label><input value={name} onChange={e => setName(e.target.value)} style={iBase} /></div>
        <div><label style={lbl}>Nome Legal</label><input value={ln} onChange={e => setLn(e.target.value)} style={iBase} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div><label style={lbl}>Moeda</label><div style={{ display: 'flex', gap: 4 }}>{['EUR', 'USD'].map(c => (<button key={c} onClick={() => setCur(c)} style={{ flex: 1, padding: '8px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: cur === c ? '#6366f1' : 'transparent', color: cur === c ? '#fff' : '#6b7185' }}>{c}</button>))}</div></div>
        <div><label style={lbl}>Método</label><select value={meth} onChange={e => setMeth(e.target.value)} style={{ ...iBase, appearance: 'none' as const }}><option value="">—</option><option value="wire">Wire</option><option value="crypto">Crypto</option><option value="capitalist">Capitalist</option><option value="revolut">Revolut</option></select></div>
        <div><label style={lbl}>Threshold</label><input value={th} onChange={e => setTh(e.target.value)} type="number" step="0.01" style={{ ...iBase, fontFamily: "'DM Mono', monospace" }} /></div>
      </div>
      <div style={{ marginBottom: 10 }}><label style={lbl}>Morada</label><input value={addr} onChange={e => setAddr(e.target.value)} style={iBase} /></div>
      <div style={{ marginBottom: 10 }}><label style={lbl}>Comentários</label><textarea value={comm} onChange={e => setComm(e.target.value)} rows={2} style={{ ...iBase, resize: 'vertical' as const }} /></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div><label style={lbl}>Wallet Crypto</label><input value={w} onChange={e => setW(e.target.value)} style={{ ...iBase, fontFamily: "'DM Mono', monospace", fontSize: 11 }} /></div>
        <div><label style={lbl}>Nossa Wallet</label><input value={ow} onChange={e => setOw(e.target.value)} style={{ ...iBase, fontFamily: "'DM Mono', monospace", fontSize: 11 }} /></div>
      </div>
      <div style={{ marginBottom: 10 }}><label style={lbl}>Info Adicional</label><input value={ex} onChange={e => setEx(e.target.value)} style={iBase} /></div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={ri} onChange={e => setRi(e.target.checked)} id="eri" style={{ accentColor: '#6366f1' }} />
          <label htmlFor="eri" style={{ fontSize: 11, color: '#e8eaf0', cursor: 'pointer' }}>Fatura</label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={act} onChange={e => setAct(e.target.checked)} id="eact" style={{ accentColor: '#22c55e' }} />
          <label htmlFor="eact" style={{ fontSize: 11, color: '#e8eaf0', cursor: 'pointer' }}>Ativo</label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, padding: 10, borderRadius: 7, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#6b7185', fontSize: 12, cursor: 'pointer' }}>Cancelar</button>
        <button onClick={() => { if (!name.trim()) return; onSave({ name: name.trim(), legal_name: ln || null, currency: cur, payment_method: meth || null, requires_invoice: ri, address: addr || null, comments: comm || null, wallet_crypto: w || null, our_wallet: ow || null, extra_info: ex || null, threshold: th ? parseFloat(th) : null, is_active: act }) }}
          style={{ flex: 2, padding: 10, borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Guardar</button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════
// ADD MONTH FORM
// ════════════════════════════════════════
const MONTH_ORDER = ['Jan 26','Fev 26','Mar 26','Abr 26','Mai 26','Jun 26','Jul 26','Ago 26','Set 26','Out 26','Nov 26','Dez 26']
const MONTH_INDEX_MAP: Record<string, number> = {}
MONTH_ORDER.forEach(m => {
  const [mon, yr] = m.split(' ')
  const mn = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'].indexOf(mon) + 1
  MONTH_INDEX_MAP[m] = (2000 + parseInt(yr)) * 100 + mn
})

function AddMonthForm({ onAdd, onCancel }: { onAdd: (m: string, mi: number, r: number | null, o: string, d: string | null) => void; onCancel: () => void }) {
  const avail = MONTH_ORDER
  const [sel, setSel] = useState(avail[avail.length - 1])
  const [val, setVal] = useState('')
  const [ds, setDs] = useState(TODAY)

  return (
    <div style={{ padding: 14, borderRadius: 10, marginBottom: 10, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e' }}>Adicionar Mês</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={lbl}>Mês</label>
          <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...iBase, appearance: 'none' as const }}>
            {avail.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Valor</label>
          <input value={val} onChange={e => setVal(e.target.value)} type="number" step="0.01" placeholder="Depois" style={{ ...iBase, fontFamily: "'DM Mono', monospace" }} />
        </div>
        <div>
          <label style={lbl}>Data</label>
          <input value={ds} onChange={e => setDs(e.target.value)} type="date" style={iBase} />
        </div>
      </div>
      <button onClick={() => {
        if (!sel) return
        const n = val === '' ? null : parseFloat(val)
        if (val !== '' && isNaN(n!)) return
        onAdd(sel, MONTH_INDEX_MAP[sel], n, '', n != null ? ds : null)
      }} style={{ width: '100%', padding: 10, borderRadius: 7, border: 'none', background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Adicionar</button>
    </div>
  )
}
