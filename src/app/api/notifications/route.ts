import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Use service role key for server-side operations
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
)

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || ''
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const NOTIFICATION_EMAILS = (process.env.NOTIFICATION_EMAILS || '').split(',').filter(Boolean)
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://irregular-tracker.vercel.app'

// Verify cron secret to prevent unauthorized access
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Also allow Vercel cron calls
    const userAgent = request.headers.get('user-agent') || ''
    if (!userAgent.includes('vercel-cron')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const result = await checkAndNotify()
    return NextResponse.json(result)
  } catch (error: any) {
    console.error('Notification error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Also allow manual trigger via POST
export async function POST(request: Request) {
  try {
    const result = await checkAndNotify()
    return NextResponse.json(result)
  } catch (error: any) {
    console.error('Notification error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

interface OverdueItem {
  client_name: string
  client_id: string
  month: string
  revenue: number
  paid: number
  owed: number
  currency: string
  days: number
  stage: string
}

async function checkAndNotify() {
  // 1. Get all overdue invoices
  const { data: invoices, error: invError } = await supabase
    .from('invoices')
    .select(`
      id,
      client_id,
      month,
      revenue,
      currency,
      date_set,
      stage,
      on_hold,
      clients!inner(name, currency)
    `)
    .gt('revenue', 0)
    .not('stage', 'eq', 'received')
    .not('date_set', 'is', null)

  if (invError) throw invError
  if (!invoices || invoices.length === 0) {
    return { message: 'No overdue invoices found', sent: 0 }
  }

  // 2. Get all payments to calculate outstanding amounts
  const invoiceIds = invoices.map(i => i.id)
  const { data: payments } = await supabase
    .from('payments')
    .select('invoice_id, amount')
    .in('invoice_id', invoiceIds)

  const paymentMap: Record<string, number> = {}
  ;(payments || []).forEach(p => {
    paymentMap[p.invoice_id] = (paymentMap[p.invoice_id] || 0) + p.amount
  })

  // 3. Build overdue list
  const today = new Date()
  const overdueItems: OverdueItem[] = []

  invoices.forEach(inv => {
    const paid = paymentMap[inv.id] || 0
    const owed = inv.revenue - paid
    if (owed <= 0.01) return

    const dateSet = new Date(inv.date_set)
    const days = Math.floor((today.getTime() - dateSet.getTime()) / 86400000)
    if (days < 5) return // Only notify after 5 days

    const clientData = inv.clients as any
    overdueItems.push({
      client_name: clientData.name,
      client_id: inv.client_id,
      month: inv.month,
      revenue: inv.revenue,
      paid,
      owed,
      currency: inv.currency || clientData.currency || 'EUR',
      days,
      stage: inv.stage,
    })
  })

  if (overdueItems.length === 0) {
    return { message: 'No items overdue > 5 days', sent: 0 }
  }

  // 4. Group by client
  const byClient: Record<string, OverdueItem[]> = {}
  overdueItems.forEach(item => {
    if (!byClient[item.client_name]) byClient[item.client_name] = []
    byClient[item.client_name].push(item)
  })

  // Sort clients by total owed
  const sortedClients = Object.entries(byClient).sort((a, b) => {
    const totalA = a[1].reduce((s, x) => s + x.owed, 0)
    const totalB = b[1].reduce((s, x) => s + x.owed, 0)
    return totalB - totalA
  })

  const totalOwed = overdueItems.reduce((s, x) => s + x.owed, 0)
  const clientCount = sortedClients.length

  // 5. Send Slack notification
  let slackSent = false
  if (SLACK_WEBHOOK) {
    slackSent = await sendSlack(sortedClients, totalOwed, clientCount)
  }

  // 6. Send email notification
  let emailSent = false
  if (RESEND_API_KEY && NOTIFICATION_EMAILS.length > 0) {
    emailSent = await sendEmail(sortedClients, totalOwed, clientCount)
  }

  return {
    message: `Found ${overdueItems.length} overdue items across ${clientCount} clients`,
    totalOwed,
    clientCount,
    slackSent,
    emailSent,
    items: overdueItems.length,
  }
}

function fmtValue(v: number, c: string) {
  const sym = c === 'USD' ? '$' : '€'
  const parts = Math.abs(v).toFixed(2).split('.')
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return sym + intPart + ',' + parts[1]
}

function stageLabel(stage: string) {
  const map: Record<string, string> = {
    confirm: '🔍 Confirmar nºs',
    invoice: '📄 Enviar fatura',
    request: '📨 Pedir pagamento',
    followup: '🔔 Follow-up',
  }
  return map[stage] || stage
}

async function sendSlack(
  clients: [string, OverdueItem[]][],
  totalOwed: number,
  clientCount: number
): Promise<boolean> {
  try {
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚡ Irregular — Cobranças em Atraso', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${clientCount} clientes* com valores pendentes há mais de 5 dias\n💰 Total em aberto: *€${(totalOwed / 1000).toFixed(1)}k*`,
        },
      },
      { type: 'divider' },
    ]

    // Top 10 clients
    clients.slice(0, 10).forEach(([name, items]) => {
      const clientTotal = items.reduce((s, x) => s + x.owed, 0)
      const maxDays = Math.max(...items.map(x => x.days))
      const lines = items.map(item =>
        `  • ${item.month}: ${fmtValue(item.owed, item.currency)} (${item.days}d) — ${stageLabel(item.stage)}`
      ).join('\n')

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${name}* — ${fmtValue(clientTotal, items[0].currency)} em aberto (${maxDays}d)\n${lines}`,
        },
      })
    })

    if (clients.length > 10) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_...e mais ${clients.length - 10} clientes_`,
        },
      })
    }

    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📊 Abrir Tracker', emoji: true },
            url: APP_URL,
            style: 'primary',
          },
        ],
      }
    )

    const response = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    })

    return response.ok
  } catch (error) {
    console.error('Slack error:', error)
    return false
  }
}

async function sendEmail(
  clients: [string, OverdueItem[]][],
  totalOwed: number,
  clientCount: number
): Promise<boolean> {
  try {
    const rows = clients.slice(0, 20).map(([name, items]) => {
      const clientTotal = items.reduce((s, x) => s + x.owed, 0)
      const maxDays = Math.max(...items.map(x => x.days))
      const details = items.map(item =>
        `<li>${item.month}: ${fmtValue(item.owed, item.currency)} (${item.days}d) — ${stageLabel(item.stage).replace(/[🔍📄📨🔔]/g, '')}</li>`
      ).join('')
      return `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #eee;font-weight:600">${name}</td>
          <td style="padding:12px;border-bottom:1px solid #eee;color:#ef4444;font-weight:700;font-family:monospace">${fmtValue(clientTotal, items[0].currency)}</td>
          <td style="padding:12px;border-bottom:1px solid #eee;color:#f59e0b;font-weight:600">${maxDays}d</td>
          <td style="padding:12px;border-bottom:1px solid #eee;font-size:12px"><ul style="margin:0;padding-left:16px">${details}</ul></td>
        </tr>`
    }).join('')

    const html = `
      <div style="font-family:sans-serif;max-width:700px;margin:0 auto">
        <div style="background:#0c0e14;color:white;padding:20px 24px;border-radius:12px 12px 0 0">
          <h1 style="margin:0;font-size:20px">⚡ Irregular — Cobranças em Atraso</h1>
          <p style="margin:6px 0 0;color:#a5b4fc;font-size:14px">${clientCount} clientes · €${(totalOwed / 1000).toFixed(1)}k em aberto</p>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#f9fafb">
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280">Cliente</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280">Em Aberto</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280">Dias</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280">Detalhe</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="text-align:center;margin:20px 0">
          <a href="${APP_URL}" style="display:inline-block;padding:12px 28px;background:#6366f1;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Abrir Tracker</a>
        </div>
        <p style="text-align:center;font-size:11px;color:#9ca3af">Enviado automaticamente pelo Irregular AR Tracker</p>
      </div>`

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Irregular Tracker <notifications@resend.dev>',
        to: NOTIFICATION_EMAILS,
        subject: `⚡ ${clientCount} clientes com €${(totalOwed / 1000).toFixed(1)}k em atraso — Irregular`,
        html,
      }),
    })

    return response.ok
  } catch (error) {
    console.error('Email error:', error)
    return false
  }
}
