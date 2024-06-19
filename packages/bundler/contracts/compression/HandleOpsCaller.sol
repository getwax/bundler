//SPDX-License-Identifier: Unlicense
pragma solidity >=0.7.0 <0.9.0;
pragma abicoder v2;

import {
    IEntryPoint,
    UserOperation
} from "./I4337.sol";
import {VLQ} from "./VLQ.sol";
import {BitStack} from "./BitStack.sol";
import {AddressRegistry} from "./AddressRegistry.sol";
import {RegIndex} from "./RegIndex.sol";
import {PseudoFloat} from "./PseudoFloat.sol";

contract HandleOpsCaller {
    IEntryPoint entryPoint;
    address payable beneficiary;

    AddressRegistry registry;

    constructor(
        IEntryPoint entryPointParam,
        address payable beneficiaryParam,
        AddressRegistry registryParam
    ) {
        entryPoint = entryPointParam;
        beneficiary = beneficiaryParam;
        registry = registryParam;
    }

    fallback(bytes calldata stream) external returns (bytes memory) {
        uint256 len;
        (len, stream) = VLQ.decode(stream);

        uint256 bitStack;
        (bitStack, stream) = VLQ.decode(stream);

        UserOperation[] memory ops = new UserOperation[](len);

        for (uint256 i = 0; i < len; i++) {
            UserOperation memory op = ops[i];

            (
                op.sender,
                stream,
                bitStack
            ) = decodeAddress(stream, bitStack);

            (op.nonce, stream) = VLQ.decode(stream);

            bool hasInitCode;
            (hasInitCode, bitStack) = BitStack.pop(bitStack);

            if (hasInitCode) {
                (op.initCode, stream) = decodeBytes(stream);
            }

            (op.callData, stream) = decodeBytes(stream);

            bool usesDecompressAndPerform;
            (usesDecompressAndPerform, bitStack) = BitStack.pop(bitStack);

            if (usesDecompressAndPerform) {
                op.callData = abi.encodeWithSignature("decompressAndPerform(bytes)", op.callData);
            }

            (op.callGasLimit, stream) = PseudoFloat.decode(stream);
            (op.verificationGasLimit, stream) = PseudoFloat.decode(stream);
            (op.preVerificationGas, stream) = PseudoFloat.decode(stream);
            (op.maxFeePerGas, stream) = PseudoFloat.decode(stream);
            (op.maxPriorityFeePerGas, stream) = PseudoFloat.decode(stream);

            bool hasPaymaster;
            (hasPaymaster, bitStack) = BitStack.pop(bitStack);

            if (hasPaymaster) {
                (op.paymasterAndData, stream) = decodeBytes(stream);
            }

            (op.signature, stream) = decodeBytes(stream);
        }

        entryPoint.handleOps(ops, beneficiary);

        return hex"";
    }

    function decodeAddress(
        bytes calldata stream,
        uint256 bitStack
    ) internal view returns (
        address,
        bytes calldata,
        uint256
    ) {
        bool useRegistry;
        (useRegistry, bitStack) = BitStack.pop(bitStack);

        if (useRegistry) {
            uint256 id;
            (id, stream) = RegIndex.decode(stream);

            return (registry.lookup(id), stream, bitStack);
        }

        return (address(bytes20(stream[:20])), stream[20:], bitStack);
    }

    function decodeBytes(
        bytes calldata stream
    ) internal pure returns (bytes memory, bytes calldata) {
        uint256 len;
        (len, stream) = VLQ.decode(stream);
        bytes memory bytes_ = stream[:len];
        stream = stream[len:];

        return (bytes_, stream);
    }
}
