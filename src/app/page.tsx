'use client'

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
}

function daysB(a: string, b: string) { return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) }
function fmt(v: number | null | undefined, c: string) {
  if (v == null) return '—'
  return (c === 'USD' ? '$' : '€') + v.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function calcSt(revenue: number | null, totalPaid: number) {
  if (revenue == null) return 'pending'
  if (revenue === 0) return 'zero'
  if (totalPaid <= 0) return 'unpaid'
  if (totalPaid >= revenue - 0.01) return 'paid'
  return 'partial'
}

const iBase: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.08)', background: '#0c0e14',
  color: '#e8eaf0', fontSize: 13, outline: 'none',
}

// ─── Types ───
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
  obs: string | null; date_set: string | null; stage: string;
}

interface Payment {
  id: string; invoice_id: string; amount: number;
  payment_date: string; method: string | null; note: string | null;
}

interface Note {
  id: string; client_id: string; invoice_id: string | null;
  text: string; author_initials: string; created_at: string;
}

// ─── Small Components ───
function Badge({ status }: { status: string }) {
  const s = SM[status] || SM.pending
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 5, fontSize: 9, fontWeight: 600, color: s.c, background: s.b, textTransform: 'uppercase' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.c }} />
      {s.l}
    </span>
  )
}

function StagePill({ stage, onAdv }: { stage: string; onAdv?: (s: string) => void }) {
  const s = STAGES.find(x => x.id === stage) || STAGES[0]
  const idx = STAGES.findIndex(x => x.id === stage)
  const next = idx < STAGES.length - 1 ? STAGES[idx + 1] : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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

// ─── Main App ───
export default function Tracker() {
  const [clients, setClients] = useState<Client[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showAging, setShowAging] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)

  // ─── Load data ───
  const loadData = useCallback(async () => {
    const [cRes, iRes, pRes, nRes] = await Promise.all([
      supabase.from('clients').select('*').order('name'),
      supabase.from('invoices').select('*').order('month_index'),
      supabase.from('payments').select('*'),
      supabase.from('notes').select('*').order('created_at', { ascending: false }),
    ])
    if (cRes.data) setClients(cRes.data)
    if (iRes.data) setInvoices(iRes.data)
    if (pRes.data) setPayments(pRes.data)
    if (nRes.data) setNotes(nRes.data)
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ─── Computed data ───
  const enriched = useMemo(() => {
    return clients.map(c => {
      const cInvs = invoices.filter(i => i.client_id === c.id)
      let totalRev = 0, totalPaid = 0, hasOverdue = false, maxDays = 0, totalHold = 0

      cInvs.forEach(inv => {
        totalRev += inv.revenue || 0
        totalHold += inv.on_hold || 0
        const invPays = payments.filter(p => p.invoice_id === inv.id)
        const paid = invPays.reduce((s, p) => s + p.amount, 0)
        totalPaid += paid
        const st = calcSt(inv.revenue, paid)
        if (st === 'unpaid' || st === 'partial') {
          hasOverdue = true
          if (inv.date_set) {
            const d = daysB(inv.date_set, TODAY)
            if (d > maxDays) maxDays = d
          }
        }
      })

      return { ...c, totalRev, totalPaid, totalOwed: totalRev - totalPaid, hasOverdue, maxDays, totalHold, invoiceCount: cInvs.length }
    })
  }, [clients, invoices, payments])

  const kpis = useMemo(() => {
    let r = 0, p = 0, oc = 0, h = 0
    enriched.forEach(c => { r += c.totalRev; p += c.totalPaid; if (c.hasOverdue) oc++; h += c.totalHold })
    return { r, p, o: r - p, oc, h }
  }, [enriched])

  const filtered = useMemo(() => {
    let list = enriched.filter(c => c.is_active)
    if (search) list = list.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    if (filter === 'overdue') list = list.filter(c => c.hasOverdue)
    if (filter === 'paid') list = list.filter(c => !c.hasOverdue)
    return list.sort((a, b) => b.maxDays - a.maxDays || b.totalOwed - a.totalOwed)
  }, [enriched, search, filter])

  // ─── Actions ───
  const actions = useMemo(() => {
    const list: { client: string; month: string; cur: string; amt: number; days: number; action: string; icon: string; pri: number }[] = []
    clients.forEach(c => {
      const cInvs = invoices.filter(i => i.client_id === c.id)
      cInvs.forEach(inv => {
        if (!inv.revenue || inv.revenue === 0) return
        const invPays = payments.filter(p => p.invoice_id === inv.id)
        const paid = invPays.reduce((s, p) => s + p.amount, 0)
        if (paid >= (inv.revenue || 0) - 0.01) return
        const days = inv.date_set ? daysB(inv.date_set, TODAY) : 0
        const map: Record<string, { action: string; icon: string; pri: number }> = {
          confirm: { action: 'Confirmar nºs', icon: '🔍', pri: 1 },
          invoice: { action: 'Enviar fatura', icon: '📄', pri: 2 },
          request: { action: 'Pedir pagamento', icon: '📨', pri: 3 },
        }
        if (map[inv.stage]) list.push({ client: c.name, month: inv.month, cur: c.currency, amt: inv.revenue!, days, ...map[inv.stage] })
        else if (inv.stage === 'followup' && days > 5) list.push({ client: c.name, month: inv.month, cur: c.currency, amt: inv.revenue!, days, action: `Follow-up (${days}d)`, icon: '🔔', pri: 4 })
      })
    })
    return list.sort((a, b) => a.pri - b.pri || b.days - a.days).slice(0, 8)
  }, [clients, invoices, payments])

  // ─── Mutations ───
  const updateInvoice = async (id: string, data: Partial<Invoice>) => {
    await supabase.from('invoices').update(data).eq('id', id)
    loadData()
  }

  const addPayment = async (invoiceId: string, data: { amount: number; payment_date: string; method: string; note: string }) => {
    await supabase.from('payments').insert({ invoice_id: invoiceId, ...data })
    loadData()
  }

  const editPayment = async (id: string, data: Partial<Payment>) => {
    await supabase.from('payments').update(data).eq('id', id)
    loadData()
  }

  const deletePayment = async (id: string) => {
    await supabase.from('payments').delete().eq('id', id)
    loadData()
  }

  const addNote = async (clientId: string, text: string) => {
    await supabase.from('notes').insert({ client_id: clientId, text, author_initials: 'JA' })
    loadData()
  }

  const editNote = async (id: string, text: string) => {
    await supabase.from('notes').update({ text }).eq('id', id)
    loadData()
  }

  const deleteNote = async (id: string) => {
    await supabase.from('notes').delete().eq('id', id)
    loadData()
  }

  const addInvoice = async (clientId: string, month: string, monthIndex: number, revenue: number | null, obs: string, dateSet: string | null) => {
    await supabase.from('invoices').insert({
      client_id: clientId, month, month_index: monthIndex,
      revenue, obs, date_set: dateSet, stage: 'confirm', on_hold: 0,
      currency: clients.find(c => c.id === clientId)?.currency || 'EUR',
    })
    loadData()
  }

  const selectedClient = clients.find(c => c.id === selId)
  const selectedInvoices = invoices.filter(i => i.client_id === selId).sort((a, b) => a.month_index - b.month_index)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: '#6366f1', transform: 'rotate(45deg)', margin: '0 auto 12px' }} />
          <div style={{ fontSize: 14, color: '#6b7185' }}>A carregar dados...</div>
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
          </div>
          <p style={{ fontSize: 11, color: '#6b7185', margin: 0 }}>Accounts Receivable Tracker · {clients.length} clientes</p>
        </div>
        <button onClick={() => setShowAging(!showAging)} style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: showAging ? '#6366f1' : 'transparent', color: showAging ? '#fff' : '#6b7185' }}>
          Aging Report
        </button>
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { l: 'Faturado', v: '€' + (kpis.r / 1000).toFixed(0) + 'k', a: '#6366f1' },
          { l: 'Recebido', v: '€' + (kpis.p / 1000).toFixed(0) + 'k', a: '#22c55e' },
          { l: 'Em Aberto', v: '€' + (kpis.o / 1000).toFixed(0) + 'k', a: '#ef4444' },
          { l: 'On Hold', v: '€' + (kpis.h / 1000).toFixed(1) + 'k', a: '#f97316' },
          { l: 'C/ Atraso', v: String(kpis.oc), a: '#f59e0b' },
        ].map((k, i) => (
          <div key={i} style={{ flex: 1, minWidth: 115, padding: '13px 14px', borderRadius: 10, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: k.a }} />
            <div style={{ fontSize: 8, color: '#6b7185', fontWeight: 600, textTransform: 'uppercase', marginBottom: 3 }}>{k.l}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Action Queue */}
      {actions.length > 0 && (
        <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>⚡ Ações Pendentes</div>
          {actions.map((a, i) => (
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
            {[
              { min: 31, max: 9999, label: '30+', color: '#ef4444' },
              { min: 16, max: 30, label: '16-30', color: '#f97316' },
              { min: 8, max: 15, label: '8-15', color: '#f59e0b' },
              { min: 0, max: 7, label: '0-7', color: '#22c55e' },
            ].map(cfg => {
              let count = 0, total = 0
              invoices.forEach(inv => {
                if (!inv.date_set || !inv.revenue || inv.revenue <= 0) return
                const invPays = payments.filter(p => p.invoice_id === inv.id)
                const paid = invPays.reduce((s, p) => s + p.amount, 0)
                if (paid >= inv.revenue - 0.01) return
                const days = daysB(inv.date_set, TODAY)
                if (days >= cfg.min && days <= cfg.max) { count++; total += inv.revenue - paid }
              })
              return (
                <div key={cfg.label} style={{ flex: 1, minWidth: 120, padding: '10px 12px', borderRadius: 9, background: cfg.color + '0A', border: '1px solid ' + cfg.color + '20' }}>
                  <div style={{ fontSize: 9, fontWeight: 600, color: cfg.color, textTransform: 'uppercase', marginBottom: 4 }}>{cfg.label} dias</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: cfg.color, fontFamily: "'DM Mono', monospace" }}>{count > 0 ? '€' + (total / 1000).toFixed(1) + 'k' : '—'}</div>
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
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar..."
            style={{ padding: '6px 10px', borderRadius: 6, width: 200, fontSize: 11, outline: 'none', border: '1px solid rgba(255,255,255,0.08)', background: '#0c0e14', color: '#e8eaf0' }} />
          <div style={{ display: 'flex', gap: 3 }}>
            {[['all', 'Todos'], ['overdue', 'Em atraso'], ['paid', 'Em dia']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.08)', background: filter === k ? '#6366f1' : 'transparent', color: filter === k ? '#fff' : '#6b7185' }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 75px 55px 55px', padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 8, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' }}>
          <span>Cliente</span><span style={{ textAlign: 'right' }}>Em Aberto</span><span style={{ textAlign: 'center' }}>Estado</span><span style={{ textAlign: 'center' }}>Dias</span><span style={{ textAlign: 'center' }}>Moeda</span>
        </div>

        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {filtered.map(c => {
            const cInvs = invoices.filter(i => i.client_id === c.id)
            const lastInv = [...cInvs].reverse().find(i => (i.revenue || 0) > 0)
            const lastPaid = lastInv ? payments.filter(p => p.invoice_id === lastInv.id).reduce((s, p) => s + p.amount, 0) : 0
            const lastSt = lastInv ? calcSt(lastInv.revenue, lastPaid) : 'pending'

            return (
              <div key={c.id} onClick={() => setSelId(c.id)}
                style={{ display: 'grid', gridTemplateColumns: '1fr 90px 75px 55px 55px', alignItems: 'center', padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.03)', background: selId === c.id ? 'rgba(99,102,241,0.08)' : 'transparent', transition: 'background .1s' }}
                onMouseEnter={e => { if (selId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'rgba(99,102,241,0.04)' }}
                onMouseLeave={e => { if (selId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                    {c.name}{c.hasOverdue && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444' }} />}
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7185', marginTop: 1 }}>{c.payment_method || '—'}{c.totalHold > 0 ? ' · 🔒' : ''}</div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: c.totalOwed > 0.01 ? '#ef4444' : '#22c55e' }}>
                  {c.totalOwed > 0.01 ? fmt(c.totalOwed, c.currency) : '✓'}
                </div>
                <div style={{ textAlign: 'center' }}><Badge status={lastSt} /></div>
                <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: c.maxDays > 20 ? '#ef4444' : c.maxDays > 7 ? '#f59e0b' : '#6b7185' }}>
                  {c.hasOverdue && c.maxDays > 0 ? c.maxDays + 'd' : '—'}
                </div>
                <div style={{ fontSize: 9, color: '#6b7185', textAlign: 'center' }}>{c.currency}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Detail Panel */}
      {selectedClient && (
        <ClientPanel
          client={selectedClient}
          invoices={selectedInvoices}
          payments={payments}
          notes={notes.filter(n => n.client_id === selectedClient.id)}
          onClose={() => setSelId(null)}
          onUpdateInvoice={updateInvoice}
          onAddPayment={addPayment}
          onEditPayment={editPayment}
          onDeletePayment={deletePayment}
          onAddNote={addNote}
          onEditNote={editNote}
          onDeleteNote={deleteNote}
          onAddInvoice={addInvoice}
        />
      )}
    </div>
  )
}

// ─── Client Panel ───
function ClientPanel({
  client, invoices, payments, notes, onClose,
  onUpdateInvoice, onAddPayment, onEditPayment, onDeletePayment,
  onAddNote, onEditNote, onDeleteNote, onAddInvoice,
}: {
  client: Client; invoices: Invoice[]; payments: Payment[]; notes: Note[];
  onClose: () => void;
  onUpdateInvoice: (id: string, data: any) => void;
  onAddPayment: (invoiceId: string, data: any) => void;
  onEditPayment: (id: string, data: any) => void;
  onDeletePayment: (id: string) => void;
  onAddNote: (clientId: string, text: string) => void;
  onEditNote: (id: string, text: string) => void;
  onDeleteNote: (id: string) => void;
  onAddInvoice: (clientId: string, month: string, monthIndex: number, revenue: number | null, obs: string, dateSet: string | null) => void;
}) {
  const [editId, setEditId] = useState<string | null>(null)
  const [payId, setPayId] = useState<string | null>(null)
  const [editPayId, setEditPayId] = useState<string | null>(null)
  const [editNoteId, setEditNoteId] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [newNote, setNewNote] = useState('')
  const [showAddMonth, setShowAddMonth] = useState(false)

  const totals = useMemo(() => {
    let r = 0, p = 0, h = 0
    invoices.forEach(inv => {
      r += inv.revenue || 0; h += inv.on_hold || 0
      p += payments.filter(pay => pay.invoice_id === inv.id).reduce((s, pay) => s + pay.amount, 0)
    })
    return { r, p, o: r - p, h }
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
          <button onClick={onClose} style={{ background: '#12151e', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, color: '#e8eaf0', padding: '5px 12px', cursor: 'pointer' }}>✕</button>
        </div>

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 6, padding: '12px 20px', flexWrap: 'wrap' }}>
          {[
            { l: 'Faturado', v: fmt(totals.r, client.currency), c: '#a5b4fc' },
            { l: 'Recebido', v: fmt(totals.p, client.currency), c: '#22c55e' },
            { l: 'Em Aberto', v: fmt(totals.o, client.currency), c: totals.o > 0 ? '#ef4444' : '#22c55e' },
            ...(totals.h > 0 ? [{ l: 'On Hold', v: fmt(totals.h, client.currency), c: '#f97316' }] : []),
          ].map((k, i) => (
            <div key={i} style={{ flex: 1, minWidth: 90, padding: '9px 11px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 8, color: k.c, fontWeight: 600, textTransform: 'uppercase' as const }}>{k.l}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: k.c, fontFamily: "'DM Mono', monospace", marginTop: 2 }}>{k.v}</div>
            </div>
          ))}
        </div>

        {/* Client Info */}
        {(client.legal_name || client.comments) && (
          <div style={{ padding: '0 20px 8px' }}>
            <div style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.07)', fontSize: 10, color: '#a5b4fc', lineHeight: 1.5 }}>
              {client.legal_name && <div><strong>Legal:</strong> {client.legal_name}</div>}
              {client.comments && <div style={{ marginTop: 2 }}>{client.comments}</div>}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div style={{ padding: '0 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ fontSize: 11, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, margin: 0 }}>Timeline ({invoices.length})</h3>
            {!showAddMonth && (
              <button onClick={() => { clear(); setShowAddMonth(true) }}
                style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)', color: '#22c55e' }}>+ Mês</button>
            )}
          </div>

          {showAddMonth && (
            <AddMonthForm
              existingMonths={invoices.map(i => i.month)}
              onAdd={(month, monthIndex, rev, obs, ds) => { onAddInvoice(client.id, month, monthIndex, rev, obs, ds); setShowAddMonth(false) }}
              onCancel={() => setShowAddMonth(false)}
            />
          )}

          {invoices.map(inv => {
            const invPays = payments.filter(p => p.invoice_id === inv.id)
            const paid = invPays.reduce((s, p) => s + p.amount, 0)
            const status = calcSt(inv.revenue, paid)
            const rem = (inv.revenue || 0) - paid
            const days = inv.date_set && inv.revenue && inv.revenue > 0 ? daysB(inv.date_set, TODAY) : null
            const resolved = status === 'paid'
            const resDays = resolved && inv.date_set && invPays.length > 0
              ? daysB(inv.date_set, invPays.reduce((l, p) => p.payment_date > l ? p.payment_date : l, ''))
              : null

            return (
              <div key={inv.id} style={{ marginBottom: 6, borderRadius: 9, background: '#12151e', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ padding: '11px 13px' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{inv.month}</span>
                      {!resolved && days != null && days > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: days > 20 ? '#ef4444' : days > 7 ? '#f59e0b' : '#6b7185', background: (days > 20 ? '#ef4444' : days > 7 ? '#f59e0b' : '#6b7280') + '15' }}>⏱ {days}d</span>
                      )}
                      {resDays != null && <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: '#22c55e', background: 'rgba(34,197,94,0.1)' }}>✓ {resDays}d</span>}
                      {inv.on_hold > 0 && <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: '#f97316', background: 'rgba(249,115,22,0.1)' }}>🔒 {fmt(inv.on_hold, client.currency)}</span>}
                    </div>
                    <StagePill stage={inv.stage} onAdv={!resolved ? ns => onUpdateInvoice(inv.id, { stage: ns }) : undefined} />
                  </div>

                  {/* Numbers */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5, marginBottom: 6 }}>
                    <div>
                      <div style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 1 }}>Faturado</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: inv.revenue != null ? '#e8eaf0' : '#6b7185' }}>
                          {inv.revenue != null ? fmt(inv.revenue, client.currency) : '—'}
                        </span>
                        <button onClick={() => { clear(); setEditId(editId === inv.id ? null : inv.id) }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, padding: 0, opacity: 0.5 }}>✏️</button>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 1 }}>Recebido</div>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: paid > 0 ? '#22c55e' : '#6b7185' }}>{fmt(paid, client.currency)}</span>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 1 }}>Em falta</div>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: rem > 0.01 ? '#ef4444' : '#6b7185' }}>{rem > 0.01 ? fmt(rem, client.currency) : '—'}</span>
                    </div>
                  </div>

                  {/* Edit revenue */}
                  {editId === inv.id && (
                    <EditRevForm invoice={inv} currency={client.currency}
                      onSave={(data) => { onUpdateInvoice(inv.id, data); setEditId(null) }}
                      onCancel={() => setEditId(null)} />
                  )}

                  {/* Payments */}
                  {invPays.length > 0 && editId !== inv.id && (
                    <div style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 8, color: '#6b7185', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 3 }}>Pagamentos ({invPays.length})</div>
                      {invPays.map(p => {
                        if (editPayId === p.id) {
                          return <EditPayInline key={p.id} pay={p} currency={client.currency}
                            onSave={data => { onEditPayment(p.id, data); setEditPayId(null) }}
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
                                <button onClick={() => { onDeletePayment(p.id); setConfirmDel(null) }}
                                  style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 600, cursor: 'pointer' }}>Sim</button>
                                <button onClick={() => setConfirmDel(null)}
                                  style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#6b7185', fontSize: 9, cursor: 'pointer' }}>Não</button>
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

                  {inv.revenue != null && inv.revenue > 0 && status !== 'paid' && editId !== inv.id && payId !== inv.id && (
                    <button onClick={() => { clear(); setPayId(inv.id) }}
                      style={{ width: '100%', padding: 7, borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(99,102,241,0.25)', background: 'transparent', color: '#6366f1' }}>+ Registar Pagamento</button>
                  )}

                  {payId === inv.id && (
                    <PayFormInline invoiceId={inv.id} revenue={inv.revenue!} currency={client.currency} payments={invPays}
                      onAdd={data => { onAddPayment(inv.id, data); setPayId(null) }}
                      onClose={() => setPayId(null)} />
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Notes */}
        <div style={{ padding: '12px 20px 24px' }}>
          <h3 style={{ fontSize: 11, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, marginBottom: 6, margin: 0, marginBottom: 6 }}>Notas ({notes.length})</h3>
          {notes.map(n => {
            if (editNoteId === n.id) {
              return <EditNoteInline key={n.id} note={n} onSave={text => { onEditNote(n.id, text); setEditNoteId(null) }} onCancel={() => setEditNoteId(null)} />
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
                    <button onClick={() => { onDeleteNote(n.id); setConfirmDel(null) }}
                      style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 600, cursor: 'pointer' }}>Sim</button>
                    <button onClick={() => setConfirmDel(null)}
                      style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#6b7185', fontSize: 9, cursor: 'pointer' }}>Não</button>
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

// ─── Inline Forms ───
function EditRevForm({ invoice, currency, onSave, onCancel }: { invoice: Invoice; currency: string; onSave: (data: any) => void; onCancel: () => void }) {
  const [val, setVal] = useState(invoice.revenue != null ? String(invoice.revenue) : '')
  const [obs, setObs] = useState(invoice.obs || '')
  const [ds, setDs] = useState(invoice.date_set || TODAY)
  const [oh, setOh] = useState(String(invoice.on_hold || 0))

  return (
    <div style={{ padding: 14, borderRadius: 9, marginTop: 6, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc' }}>{invoice.revenue != null ? 'Editar Valor' : 'Definir Valor'}</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Valor ({currency})</label>
          <input value={val} onChange={e => setVal(e.target.value)} type="number" step="0.01" autoFocus style={{ ...iBase, fontFamily: "'DM Mono', monospace" }} />
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Data registo</label>
          <input value={ds} onChange={e => setDs(e.target.value)} type="date" style={iBase} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 10 }}>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Obs</label>
          <input value={obs} onChange={e => setObs(e.target.value)} style={iBase} />
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#f97316', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>On Hold</label>
          <input value={oh} onChange={e => setOh(e.target.value)} type="number" step="0.01" style={{ ...iBase, color: '#f97316' }} />
        </div>
      </div>
      <button onClick={() => {
        const n = val === '' ? null : parseFloat(val)
        if (val !== '' && isNaN(n!)) return
        onSave({ revenue: n, obs, date_set: n != null ? ds : null, on_hold: parseFloat(oh) || 0 })
      }} style={{ width: '100%', padding: 10, borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Guardar</button>
    </div>
  )
}

function PayFormInline({ invoiceId, revenue, currency, payments: invPays, onAdd, onClose }: {
  invoiceId: string; revenue: number; currency: string; payments: Payment[];
  onAdd: (data: any) => void; onClose: () => void;
}) {
  const [amt, setAmt] = useState('')
  const [date, setDate] = useState(TODAY)
  const [meth, setMeth] = useState('wire')
  const [note, setNote] = useState('')
  const ep = invPays.reduce((s, p) => s + p.amount, 0)
  const rem = revenue - ep
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
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Valor ({currency})</label>
          <div style={{ position: 'relative' }}>
            <input value={amt} onChange={e => setAmt(e.target.value)} type="number" step="0.01" style={{ ...iBase, paddingRight: 55, fontFamily: "'DM Mono', monospace" }} />
            <button onClick={() => setAmt(rem.toFixed(2))} style={{ position: 'absolute', right: 4, top: 4, bottom: 4, padding: '0 7px', borderRadius: 5, border: 'none', background: '#6366f1', color: '#fff', fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>TOTAL</button>
          </div>
          <div style={{ fontSize: 9, color: '#6b7185', marginTop: 2 }}>Falta: {fmt(rem, currency)}</div>
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Data</label>
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
      <button onClick={() => {
        const v = parseFloat(amt)
        if (isNaN(v) || v < 0 || !date) return
        onAdd({ amount: v, payment_date: date, method: meth, note })
      }} style={{ width: '100%', padding: 10, borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Confirmar</button>
    </div>
  )
}

function EditPayInline({ pay, currency, onSave, onCancel }: { pay: Payment; currency: string; onSave: (data: any) => void; onCancel: () => void }) {
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

function EditNoteInline({ note, onSave, onCancel }: { note: Note; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(note.text)
  return (
    <div style={{ padding: '8px 10px', marginBottom: 3, borderRadius: 6, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
        style={{ ...iBase, fontSize: 11, resize: 'vertical', marginBottom: 6 }} />
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#6b7185', fontSize: 10, cursor: 'pointer' }}>Cancelar</button>
        <button onClick={() => onSave(text)} style={{ padding: '4px 10px', borderRadius: 5, border: 'none', background: '#6366f1', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>Guardar</button>
      </div>
    </div>
  )
}

const MONTH_ORDER = [
  'Jan 24','Fev 24','Mar 24','Abr 24','Mai 24','Jun 24','Jul 24','Ago 24','Set 24','Out 24','Nov 24','Dez 24',
  'Jan 25','Fev 25','Mar 25','Abr 25','Mai 25','Jun 25','Jul 25','Ago 25','Set 25','Out 25','Nov 25','Dez 25',
  'Jan 26','Fev 26','Mar 26','Abr 26','Mai 26','Jun 26','Jul 26','Ago 26','Set 26','Out 26','Nov 26','Dez 26',
]
const MONTH_INDEX_MAP: Record<string, number> = {}
MONTH_ORDER.forEach((m, i) => {
  const [mon, yr] = m.split(' ')
  const monNum = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'].indexOf(mon) + 1
  MONTH_INDEX_MAP[m] = (2000 + parseInt(yr)) * 100 + monNum
})

function AddMonthForm({ existingMonths, onAdd, onCancel }: {
  existingMonths: string[];
  onAdd: (month: string, monthIndex: number, rev: number | null, obs: string, dateSet: string | null) => void;
  onCancel: () => void;
}) {
  const used = new Set(existingMonths)
  const avail = MONTH_ORDER.filter(m => !used.has(m))
  const [sel, setSel] = useState(avail.length ? avail[avail.length - 1] : '')
  const [val, setVal] = useState('')
  const [obs, setObs] = useState('')
  const [ds, setDs] = useState(TODAY)

  if (!avail.length) return <div style={{ padding: 12, fontSize: 11, color: '#6b7185' }}>Todos os meses adicionados.</div>

  return (
    <div style={{ padding: 14, borderRadius: 10, marginBottom: 10, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e' }}>Adicionar Mês</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#6b7185', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Mês</label>
          <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...iBase, appearance: 'none' as const }}>
            {avail.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Valor</label>
          <input value={val} onChange={e => setVal(e.target.value)} type="number" step="0.01" placeholder="Depois" style={{ ...iBase, fontFamily: "'DM Mono', monospace" }} />
        </div>
        <div>
          <label style={{ fontSize: 9, fontWeight: 600, color: '#6b7185', textTransform: 'uppercase' as const, display: 'block', marginBottom: 3 }}>Data</label>
          <input value={ds} onChange={e => setDs(e.target.value)} type="date" style={iBase} />
        </div>
      </div>
      <button onClick={() => {
        if (!sel) return
        const n = val === '' ? null : parseFloat(val)
        if (val !== '' && isNaN(n!)) return
        onAdd(sel, MONTH_INDEX_MAP[sel], n, obs, n != null ? ds : null)
      }} style={{ width: '100%', padding: 10, borderRadius: 7, border: 'none', background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Adicionar</button>
    </div>
  )
}
