import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useReportMembers } from '../reports/useReportMembers'
import type { CubeModelMeta } from '../querybuilder'

const meta: CubeModelMeta = {
  cubes: [
    {
      name: 'Orders',
      measures: [{ name: 'aov', member: 'Orders.aov', title: 'Average order value', format: 'currency' }],
      dimensions: [{ name: 'customer_id', member: 'Orders.customer_id', title: 'Customer', drill_entity: 'customer' }],
    },
  ],
}

describe('useReportMembers', () => {
  it('indexes the model by member: titles, formats, drill entities', async () => {
    const client = { fetchMeta: async () => meta }
    const { result } = renderHook(() => useReportMembers(client))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.['Orders.aov']).toMatchObject({ title: 'Average order value', format: 'currency' })
    expect(result.current?.['Orders.customer_id']).toMatchObject({ title: 'Customer', entity: 'customer' })
  })

  it('stays undefined when /meta fails, so widgets fall back to humanized names', async () => {
    const client = { fetchMeta: async () => Promise.reject(new Error('503')) }
    const { result } = renderHook(() => useReportMembers(client))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current).toBeUndefined()
  })
})
