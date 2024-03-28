import { UserOperation } from '@account-abstraction/utils'
import { AddressRegistry, BLSSignatureAggregator } from '../types'
import { BigNumber, BigNumberish } from 'ethers'
import { defaultAbiCoder, hexlify, isAddress, keccak256 } from 'ethers/lib/utils'

export default class Compressor {
  constructor (
    readonly registry: AddressRegistry,
    readonly aggregator: BLSSignatureAggregator
  ) {}

  async encodeHandleOps (
    ops: UserOperation[]
  ): Promise<string> {
    const encodedLen = encodeVLQ(BigInt(ops.length))

    const bits: boolean[] = []
    const encodedOps: string[] = []

    for (const op of ops) {
      const encodeResult = await this.encodeOpWithoutSignature(op)

      bits.push(...encodeResult.bits)

      encodedOps.push(
        hexJoin([encodeResult.encodedOp, encodeBytes(hexlify(op.signature))])
      )
    }

    return hexJoin([encodedLen, encodeBitStack(bits), ...encodedOps])
  }

  async encodeHandleAggregatedOps (
    ops: UserOperation[]
  ): Promise<string> {
    throw new Error('todo')
  }

  async encodeOpWithoutSignature (op: UserOperation): Promise<{
    bits: boolean[]
    encodedOp: string
  }> {
    const bits: boolean[] = []
    const parts: string[] = []

    const senderIndex = await this.lookupAddress(op.sender)

    if (senderIndex === undefined) {
      bits.push(false)
      parts.push(op.sender)
    } else {
      bits.push(true)
      parts.push(encodeRegIndex(senderIndex))
    }

    parts.push(encodeVLQ(op.nonce))

    if (hexLen(hexlify(op.initCode)) === 0) {
      bits.push(false)
    } else {
      bits.push(true)
      parts.push(encodeBytes(hexlify(op.initCode)))
    }

    this.encodeUserOpCalldata(bits, parts, hexlify(op.callData))

    parts.push(encodePseudoFloat(op.callGasLimit))
    parts.push(encodePseudoFloat(op.verificationGasLimit))
    parts.push(encodePseudoFloat(op.preVerificationGas))
    parts.push(encodePseudoFloat(op.maxFeePerGas))
    parts.push(encodePseudoFloat(op.maxPriorityFeePerGas))

    if (hexLen(hexlify(op.paymasterAndData)) === 0) {
      bits.push(false)
    } else {
      bits.push(true)
      parts.push(encodeBytes(hexlify(op.paymasterAndData)))
    }

    return {
      bits,
      encodedOp: hexJoin(parts)
    }
  }

  encodeUserOpCalldata (bits: boolean[], parts: string[], calldata: string): void {
    let decompressAndPerformBytes: string | undefined

    if (calldata.startsWith(decompressAndPerformSelector)) {
      try {
        const bytesArg = defaultAbiCoder.decode(
          ['bytes'],
          `0x${calldata.slice(10)}`
        )[0] as string

        if (
          hexJoin([
            decompressAndPerformSelector,
            defaultAbiCoder.encode(['bytes'], [bytesArg])
          ]) === calldata
        ) {
          decompressAndPerformBytes = bytesArg
        }
      } catch {
        // Fallthrough to default that handles any calldata
      }
    }

    if (decompressAndPerformBytes !== undefined) {
      bits.push(true)
      parts.push(encodeBytes(decompressAndPerformBytes))
    } else {
      bits.push(false)
      parts.push(encodeBytes(calldata))
    }
  }

  async lookupAddress (address: string): Promise<BigNumber | undefined> {
    if (!isAddress(address)) {
      throw new Error('Address is not valid')
    }

    const filter = this.registry.filters['AddressRegistered(uint256,address)'](
      undefined,
      address
    )

    const event = (await this.registry.queryFilter(filter)).at(0)

    return event?.args[0]
  }
}

export function hexJoin (hexStrings: string[]): string {
  return `0x${hexStrings.map((hex) => remove0x(normalizeHex(hex))).join('')}`
}

export function normalizeHex (hexString: string): string {
  if (!/^0x[0-9a-f]*$/i.test(hexString)) {
    throw new Error('Expected hex string')
  }

  const lower = hexString.toLowerCase()

  if (lower.length % 2 === 0) {
    return lower
  }

  return `0x0${lower.slice(2)}`
}

export function hexLen (hexString: string): number {
  return (hexString.length - 2) / 2
}

export function remove0x (hexString: string): string {
  if (!hexString.startsWith('0x')) {
    throw new Error('Expected 0x prefix')
  }

  return hexString.slice(2)
}

export function encodeVLQ (xParam: BigNumberish): string {
  let x = BigNumber.from(xParam)
  const segments: BigNumber[] = []

  while (true) {
    const segment = x.mod(128)
    segments.unshift(segment)
    x = x.sub(segment)
    x = x.div(128)

    if (x.eq(0)) {
      break
    }
  }

  let result = '0x'

  for (let i = 0; i < segments.length; i++) {
    const keepGoing = i !== segments.length - 1

    const byte = (keepGoing ? 128 : 0) + Number(segments[i])
    result += byte.toString(16).padStart(2, '0')
  }

  return result
}

export function encodePseudoFloat (xParam: BigNumberish): string {
  let x = BigNumber.from(xParam)

  if (x.eq(0)) {
    return '0x00'
  }

  let exponent = 0

  while (x.mod(10).eq(0) && exponent < 30) {
    x = x.div(10)
    exponent++
  }

  const exponentBits = (exponent + 1).toString(2).padStart(5, '0')

  const lowest3Bits = Number(x.mod(8))
    .toString(2)
    .padStart(3, '0')

  const firstByte = parseInt(`${exponentBits}${lowest3Bits}`, 2)
    .toString(16)
    .padStart(2, '0')

  return hexJoin([`0x${firstByte}`, encodeVLQ(x.div(8))])
}

export function encodeRegIndex (regIndexParam: BigNumberish): string {
  const regIndex = BigNumber.from(regIndexParam)
  const vlqValue = regIndex.div(0x010000)
  const fixedValue = regIndex.mod(0x010000).toNumber()

  return hexJoin([
    encodeVLQ(vlqValue),
    `0x${fixedValue.toString(16).padStart(4, '0')}`
  ])
}

/**
 * Bit stacks are just the bits of a uint256 encoded as a VLQ. There is also a
 * final 1 to indicate the end of the stack.
 * (Technically the encoding is unbounded, but 256 booleans is a lot and it's
 * much easier to just decode the VLQ into a uint256 in the EVM.)
 *
 * Notably, the bits are little endian - the first bit is the *lowest* bit. This
 * is because the lowest bit is clearly the 1-valued bit, but the highest valued
 * bit could be anywhere - there's infinitely many zero-bits to choose from.
 *
 * If it wasn't for this need to be little endian, we'd definitely use big
 * endian (like our other encodings generally do), since that's preferred by the
 * EVM and the ecosystem:
 *
 * ```ts
 * const abi = new ethers.utils.AbiCoder():
 * console.log(abi.encode(["uint"], [0xff]));
 * // 0x00000000000000000000000000000000000000000000000000000000000000ff
 *
 * // If Ethereum used little endian (like x86), it would instead be:
 * // 0xff00000000000000000000000000000000000000000000000000000000000000
 * ```
 */
export function encodeBitStack (bits: boolean[]): string {
  let stack = BigNumber.from(1)

  for (let i = bits.length - 1; i >= 0; i--) {
    stack = stack.mul(2)
    stack = stack.add(bits[i] ? 1 : 0)
  }

  const stackVLQ = encodeVLQ(stack)

  return stackVLQ
}

export function encodeBytes (bytes: string): string {
  return hexJoin([encodeVLQ(hexLen(bytes)), bytes])
}

const decompressAndPerformSelector = keccak256(
  new TextEncoder().encode('decompressAndPerform(bytes)')
).slice(0, 10)
