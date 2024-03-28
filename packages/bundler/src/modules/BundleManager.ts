import { EntryPoint } from '@account-abstraction/contracts'
import { MempoolEntry, MempoolManager } from './MempoolManager'
import { ValidateUserOpResult, ValidationManager } from '@account-abstraction/validation-manager'
import { BigNumber, BigNumberish, PopulatedTransaction } from 'ethers'
import { FeeData, JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers'
import Debug from 'debug'
import { ReputationManager, ReputationStatus } from './ReputationManager'
import { Mutex } from 'async-mutex'
import { GetUserOpHashes__factory, HandleOpsCaller } from '../types'
import { UserOperation, StorageMap, getAddr, mergeStorageMap, runContractScript } from '@account-abstraction/utils'
import { EventsManager } from './EventsManager'
import { ErrorDescription } from '@ethersproject/abi/lib/interface'
import Compressor from './Compressor'

const debug = Debug('aa.exec.cron')

const THROTTLED_ENTITY_BUNDLE_COUNT = 4

export interface SendBundleReturn {
  transactionHash: string
  userOpHashes: string[]
}

export class BundleManager {
  provider: JsonRpcProvider
  signer: JsonRpcSigner
  mutex = new Mutex()

  constructor (
    readonly entryPoint: EntryPoint,
    readonly eventsManager: EventsManager,
    readonly mempoolManager: MempoolManager,
    readonly validationManager: ValidationManager,
    readonly reputationManager: ReputationManager,
    readonly compressor: Compressor,
    readonly beneficiary: string,
    readonly minSignerBalance: BigNumberish,
    readonly maxBundleGas: number,
    // use eth_sendRawTransactionConditional with storage map
    readonly conditionalRpc: boolean,
    // in conditionalRpc: always put root hash (not specific storage slots) for "sender" entries
    readonly mergeToAccountRootHash: boolean = false
  ) {
    this.provider = entryPoint.provider as JsonRpcProvider
    this.signer = entryPoint.signer as JsonRpcSigner
  }

  /**
   * attempt to send a bundle:
   * collect UserOps from mempool into a bundle
   * send this bundle.
   */
  async sendNextBundle (): Promise<SendBundleReturn | undefined> {
    return await this.mutex.runExclusive(async () => {
      debug('sendNextBundle')

      // first flush mempool from already-included UserOps, by actively scanning past events.
      await this.handlePastEvents()

      const [bundle, storageMap] = await this.createBundle()
      if (bundle.length === 0) {
        debug('sendNextBundle - no bundle to send')
      } else {
        const beneficiary = await this._selectBeneficiary()
        const ret = await this.sendBundle(bundle, beneficiary, storageMap)
        debug(`sendNextBundle exit - after sent a bundle of ${bundle.length} `)
        return ret
      }
    })
  }

  async handlePastEvents (): Promise<void> {
    await this.eventsManager.handlePastEvents()
  }

  /**
   * submit a bundle.
   * after submitting the bundle, remove all UserOps from the mempool
   * @return SendBundleReturn the transaction and UserOp hashes on successful transaction, or null on failed transaction
   */
  async sendBundle (userOps: UserOperation[], beneficiary: string, storageMap: StorageMap): Promise<SendBundleReturn | undefined> {
    try {
      const feeData = await this.provider.getFeeData()
      const tx = await this.populateBundleTx(userOps, beneficiary, feeData)
      tx.chainId = this.provider._network.chainId
      const signedTx = await this.signer.signTransaction(tx)
      let ret: string
      if (this.conditionalRpc) {
        debug('eth_sendRawTransactionConditional', storageMap)
        ret = await this.provider.send('eth_sendRawTransactionConditional', [
          signedTx, { knownAccounts: storageMap }
        ])
        debug('eth_sendRawTransactionConditional ret=', ret)
      } else {
        // ret = await this.signer.sendTransaction(tx)
        ret = await this.provider.send('eth_sendRawTransaction', [signedTx])
        debug('eth_sendRawTransaction ret=', ret)
      }
      // TODO: parse ret, and revert if needed.
      debug('ret=', ret)
      debug('sent handleOps with', userOps.length, 'ops. removing from mempool')
      // hashes are needed for debug rpc only.
      const hashes = await this.getUserOpHashes(userOps)
      return {
        transactionHash: ret,
        userOpHashes: hashes
      }
    } catch (e: any) {
      let parsedError: ErrorDescription
      try {
        parsedError = this.entryPoint.interface.parseError((e.data?.data ?? e.data))
      } catch (e1) {
        this.checkFatal(e)
        console.warn('Failed handleOps, but non-FailedOp error', e)
        return
      }
      const {
        opIndex,
        reason
      } = parsedError.args
      const userOp = userOps[opIndex]
      const reasonStr: string = reason.toString()
      if (reasonStr.startsWith('AA3')) {
        this.reputationManager.crashedHandleOps(getAddr(userOp.paymasterAndData))
      } else if (reasonStr.startsWith('AA2')) {
        this.reputationManager.crashedHandleOps(userOp.sender)
      } else if (reasonStr.startsWith('AA1')) {
        this.reputationManager.crashedHandleOps(getAddr(userOp.initCode))
      } else {
        this.mempoolManager.removeUserOp(userOp)
        console.warn(`Failed handleOps sender=${userOp.sender} reason=${reasonStr}`)
      }
    }
  }

  async populateBundleTx (
    userOps: UserOperation[],
    beneficiary: string,
    feeData: FeeData
  ): Promise<PopulatedTransaction> {
    const userOpHashes = await this.getUserOpHashes(userOps)

    const entries = userOpHashes
      .map((hash) => this.mempoolManager.get(hash))
      .filter(notUndefined)

    const aggregationEntries = entries.filter(e => e.aggregator !== undefined)
    const nonAggregationEntries = entries.filter(e => e.aggregator === undefined)

    if (aggregationEntries.length > nonAggregationEntries.length) {
      return await this.populateAggregationBundleTx(aggregationEntries, beneficiary, feeData)
    }

    return await this.populateNonAggregationBundleTx(nonAggregationEntries.map(e => e.userOp), beneficiary, feeData)
  }

  async populateAggregationBundleTx (
    entries: MempoolEntry[],
    beneficiary: string,
    feeData: FeeData
  ): Promise<PopulatedTransaction> {
    throw new Error('TODO')
  }

  async populateNonAggregationBundleTx (
    userOps: UserOperation[],
    beneficiary: string,
    feeData: FeeData
  ): Promise<PopulatedTransaction> {
    const handleOpsCaller = await this.getHandleOpsCaller(beneficiary)
    const data = await this.compressor.encodeHandleOps(userOps)

    return {
      to: handleOpsCaller.address,
      data,

      type: 2,
      nonce: await this.signer.getTransactionCount(),
      gasLimit: BigNumber.from(10e6),
      maxPriorityFeePerGas: BigNumber.from(feeData.maxPriorityFeePerGas ?? 0),
      maxFeePerGas: BigNumber.from(feeData.maxFeePerGas ?? 0)
    }
  }

  async getHandleOpsCaller (beneficiary: string): Promise<HandleOpsCaller> {
    throw new Error('Method not implemented.')
  }

  // fatal errors we know we can't recover
  checkFatal (e: any): void {
    // console.log('ex entries=',Object.entries(e))
    if (e.error?.code === -32601) {
      throw e
    }
  }

  async createBundle (): Promise<[UserOperation[], StorageMap]> {
    const entries = this.mempoolManager.getSortedForInclusion()
    const bundle: UserOperation[] = []

    // paymaster deposit should be enough for all UserOps in the bundle.
    const paymasterDeposit: { [paymaster: string]: BigNumber } = {}
    // throttled paymasters and deployers are allowed only small UserOps per bundle.
    const stakedEntityCount: { [addr: string]: number } = {}
    // each sender is allowed only once per bundle
    const senders = new Set<string>()

    // all entities that are known to be valid senders in the mempool
    const knownSenders = this.mempoolManager.getKnownSenders()

    const storageMap: StorageMap = {}
    let totalGas = BigNumber.from(0)
    debug('got mempool of ', entries.length)
    // eslint-disable-next-line no-labels
    mainLoop:
    for (const entry of entries) {
      const paymaster = getAddr(entry.userOp.paymasterAndData)
      const factory = getAddr(entry.userOp.initCode)
      const paymasterStatus = this.reputationManager.getStatus(paymaster)
      const deployerStatus = this.reputationManager.getStatus(factory)
      if (paymasterStatus === ReputationStatus.BANNED || deployerStatus === ReputationStatus.BANNED) {
        this.mempoolManager.removeUserOp(entry.userOp)
        continue
      }
      // [SREP-030]
      if (paymaster != null && (paymasterStatus === ReputationStatus.THROTTLED ?? (stakedEntityCount[paymaster] ?? 0) > THROTTLED_ENTITY_BUNDLE_COUNT)) {
        debug('skipping throttled paymaster', entry.userOp.sender, entry.userOp.nonce)
        continue
      }
      // [SREP-030]
      if (factory != null && (deployerStatus === ReputationStatus.THROTTLED ?? (stakedEntityCount[factory] ?? 0) > THROTTLED_ENTITY_BUNDLE_COUNT)) {
        debug('skipping throttled factory', entry.userOp.sender, entry.userOp.nonce)
        continue
      }
      if (senders.has(entry.userOp.sender)) {
        debug('skipping already included sender', entry.userOp.sender, entry.userOp.nonce)
        // allow only a single UserOp per sender per bundle
        continue
      }
      let validationResult: ValidateUserOpResult
      try {
        // re-validate UserOp. no need to check stake, since it cannot be reduced between first and 2nd validation
        validationResult = await this.validationManager.validateUserOp(entry.userOp, entry.referencedContracts, false)
      } catch (e: any) {
        debug('failed 2nd validation:', e.message)
        // failed validation. don't try anymore
        this.mempoolManager.removeUserOp(entry.userOp)
        continue
      }

      for (const storageAddress of Object.keys(validationResult.storageMap)) {
        if (
          storageAddress.toLowerCase() !== entry.userOp.sender.toLowerCase() &&
          knownSenders.includes(storageAddress.toLowerCase())
        ) {
          console.debug(`UserOperation from ${entry.userOp.sender} sender accessed a storage of another known sender ${storageAddress}`)
          // eslint-disable-next-line no-labels
          continue mainLoop
        }
      }

      // todo: we take UserOp's callGasLimit, even though it will probably require less (but we don't
      // attempt to estimate it to check)
      // which means we could "cram" more UserOps into a bundle.
      const userOpGasCost = BigNumber.from(validationResult.returnInfo.preOpGas).add(entry.userOp.callGasLimit)
      const newTotalGas = totalGas.add(userOpGasCost)
      if (newTotalGas.gt(this.maxBundleGas)) {
        break
      }

      if (paymaster != null) {
        if (paymasterDeposit[paymaster] == null) {
          paymasterDeposit[paymaster] = await this.entryPoint.balanceOf(paymaster)
        }
        if (paymasterDeposit[paymaster].lt(validationResult.returnInfo.prefund)) {
          // not enough balance in paymaster to pay for all UserOps
          // (but it passed validation, so it can sponsor them separately
          continue
        }
        stakedEntityCount[paymaster] = (stakedEntityCount[paymaster] ?? 0) + 1
        paymasterDeposit[paymaster] = paymasterDeposit[paymaster].sub(validationResult.returnInfo.prefund)
      }
      if (factory != null) {
        stakedEntityCount[factory] = (stakedEntityCount[factory] ?? 0) + 1
      }

      // If sender's account already exist: replace with its storage root hash
      if (this.mergeToAccountRootHash && this.conditionalRpc && entry.userOp.initCode.length <= 2) {
        const { storageHash } = await this.provider.send('eth_getProof', [entry.userOp.sender, [], 'latest'])
        storageMap[entry.userOp.sender.toLowerCase()] = storageHash
      }
      mergeStorageMap(storageMap, validationResult.storageMap)

      senders.add(entry.userOp.sender)
      bundle.push(entry.userOp)
      totalGas = newTotalGas
    }
    return [bundle, storageMap]
  }

  /**
   * determine who should receive the proceedings of the request.
   * if signer's balance is too low, send it to signer. otherwise, send to configured beneficiary.
   */
  async _selectBeneficiary (): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress())
    let beneficiary = this.beneficiary
    // below min-balance redeem to the signer, to keep it active.
    if (currentBalance.lte(this.minSignerBalance)) {
      beneficiary = await this.signer.getAddress()
      console.log('low balance. using ', beneficiary, 'as beneficiary instead of ', this.beneficiary)
    }
    return beneficiary
  }

  // helper function to get hashes of all UserOps
  async getUserOpHashes (userOps: UserOperation[]): Promise<string[]> {
    const { userOpHashes } = await runContractScript(this.entryPoint.provider,
      new GetUserOpHashes__factory(),
      [this.entryPoint.address, userOps])

    return userOpHashes
  }
}

function notUndefined<T> (value: T): value is Exclude<T, undefined> {
  return value !== undefined
}
