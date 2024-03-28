import { UserOperation } from '@account-abstraction/utils'
import { AddressRegistry, BLSSignatureAggregator } from '../types'

export default class Compressor {
  constructor (
    readonly registry: AddressRegistry,
    readonly aggregator: BLSSignatureAggregator
  ) {}

  async encodeHandleOps (
    userOps: UserOperation[]
  ): Promise<string> {
    throw new Error('todo')
  }

  async encodeHandleAggregatedOps (
    userOps: UserOperation[]
  ): Promise<string> {
    throw new Error('todo')
  }
}
