import { useMemo } from 'react'
import { useLeash } from '../lib/store'
import { dailySpend, portfolioTotals, spendByAgent } from '../lib/selectors'
import { money } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardHead } from '../components/common/Card'
import { Kpi } from '../components/common/Kpi'
import { SpendingChart } from '../components/spending/SpendingChart'
import { SpendingByAgent } from '../components/spending/SpendingByAgent'

export function Spending() {
  const { agents, events } = useLeash()

  const totals = useMemo(() => portfolioTotals(agents, events), [agents, events])
  const points = useMemo(() => dailySpend(events, 14), [events])
  const byAgent = useMemo(() => spendByAgent(agents), [agents])

  return (
    <>
      <PageHeader title="Spending" subtitle="Track spending across your agent hierarchy." />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Total spend" value={money(totals.spent)} />
        <Kpi label="Today" value={money(totals.today)} />
        <Kpi label="This week" value={money(totals.week)} />
        <Kpi label="Remaining" value={money(totals.remaining)} tone="text-authority" />
      </div>

      <div className="mt-6 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHead title="Spend over time" />
          <div className="mt-5">
            <SpendingChart points={points} height={280} />
          </div>
        </Card>

        <Card>
          <CardHead title="Spending by agent" />
          <div className="mt-5">
            <SpendingByAgent rows={byAgent} total={totals.spent} />
          </div>
        </Card>
      </div>
    </>
  )
}
