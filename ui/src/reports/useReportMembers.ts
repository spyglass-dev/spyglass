/**
 * `useReportMembers` — the model's titles, formats and descriptions, keyed by
 * member, for `ReportCanvas` / `resolveReport` (`members`).
 *
 * One `/meta` fetch per client. A host passes the same structural client it
 * gives `useReportModel`; a `/meta` that fails leaves `undefined`, and the
 * widgets fall back to humanized member names — the report still renders.
 */
import { useEffect, useState } from 'react'
import { memberIndex, type MemberIndex } from '../members'
import type { CubeModelMeta } from '../querybuilder'

/** Anything that can fetch the model — structural, so any host client fits. */
export interface MetaClient {
  fetchMeta(): Promise<CubeModelMeta>
}

export function useReportMembers(client: MetaClient): MemberIndex | undefined {
  const [members, setMembers] = useState<MemberIndex | undefined>(undefined)
  useEffect(() => {
    let live = true
    client
      .fetchMeta()
      .then((meta) => live && setMembers(memberIndex(meta)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client])
  return members
}
