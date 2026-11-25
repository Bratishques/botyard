import { describe, expect, test } from 'bun:test'
import type { DeploymentView } from '@botyard/contract'
import { deploymentRefetchInterval, deploymentsRefetchInterval, POLL_MS } from './live'

const deployment = (patch: Partial<DeploymentView>): DeploymentView => ({
  id: 'd',
  customerId: 'c',
  destinationId: 'x',
  templateId: 'bita',
  templateVersion: 'v',
  config: {},
  tradingMode: 'sandbox',
  appName: 'by-1',
  status: 'RUNNING',
  activeOperationId: null,
  lastError: null,
  drift: null,
  driftCheckedAt: null,
  version: 1,
  createdAt: '',
  updatedAt: '',
  ...patch,
})

describe('живой статус опросом', () => {
  test('опрос только пока идёт операция; упавшее удаление (DELETING без операции) не опрашивается', () => {
    expect(deploymentRefetchInterval(deployment({}))).toBe(false)
    expect(deploymentRefetchInterval(deployment({ status: 'PROVISIONING', activeOperationId: 'op' }))).toBe(POLL_MS)
    expect(deploymentRefetchInterval(deployment({ status: 'DELETING' }))).toBe(false)
    expect(deploymentRefetchInterval(undefined)).toBe(false)
  })

  test('список опрашивается, пока занято хоть одно развёртывание', () => {
    expect(deploymentsRefetchInterval([deployment({}), deployment({ status: 'STOPPED' })])).toBe(false)
    expect(deploymentsRefetchInterval([deployment({}), deployment({ activeOperationId: 'op' })])).toBe(POLL_MS)
  })
})
