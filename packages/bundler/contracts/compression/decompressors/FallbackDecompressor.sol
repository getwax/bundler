//SPDX-License-Identifier: Unlicense
pragma solidity >=0.7.0 <0.9.0;
pragma abicoder v2;

import {WaxLib as W} from "../WaxLib.sol";
import {IDecompressor} from "./IDecompressor.sol";
import {VLQ} from "../VLQ.sol";
import {PseudoFloat} from "../PseudoFloat.sol";
import {AddressRegistry} from "../AddressRegistry.sol";
import {RegIndex} from "../RegIndex.sol";
import {BitStack} from "../BitStack.sol";

contract FallbackDecompressor is IDecompressor {
    AddressRegistry public addressRegistry;

    constructor(AddressRegistry addressRegistryParam) {
        addressRegistry = addressRegistryParam;
    }

    function decompress(
        bytes calldata stream
    ) external view returns (W.Action[] memory, uint256) {
        uint256 originalStreamLen = stream.length;

        uint256 actionLen;
        (actionLen, stream) = VLQ.decode(stream);

        W.Action[] memory actions = new W.Action[](actionLen);

        uint256 bitStack;
        (bitStack, stream) = VLQ.decode(stream);

        for (uint256 i = 0; i < actionLen; i++) {
            W.Action memory action;

            bool useRegistry;
            (useRegistry, bitStack) = BitStack.pop(bitStack);

            if (useRegistry) {
                uint256 addressIndex;
                (addressIndex, stream) = RegIndex.decode(stream);
                action.to = addressRegistry.lookup(addressIndex);
            } else {
                action.to = address(bytes20(stream[:20]));
                stream = stream[20:];
            }

            (action.value, stream) = PseudoFloat.decode(stream);

            uint256 dataLen;
            (dataLen, stream) = VLQ.decode(stream);

            action.data = stream[:dataLen];
            stream = stream[dataLen:];

            actions[i] = action;
        }

        return (actions, originalStreamLen - stream.length);
    }

    function compress(
        W.Action[] calldata actions,

        // These need to be passed in because the reverse mapping is not stored
        // on-chain. Instead, wallets should use the AddressRegistered events
        // and do an off-chain lookup to figure out which registered addresses
        // will be relevant for this call.
        AddressRegistry.Entry[] calldata registeredAddresses
    ) external pure returns (bytes memory) {
        bytes memory res = "";
        uint256 bitStack = BitStack.empty;

        for (uint256 i = 0; i < actions.length; i++) {
            W.Action memory action = actions[i];

            bool isAddressRegistered = false;
            uint256 addressIndex = 0;

            for (uint256 j = 0; j < registeredAddresses.length; j++) {
                if (registeredAddresses[j].addr == action.to) {
                    isAddressRegistered = true;
                    addressIndex = registeredAddresses[j].id;
                    break;
                }
            }

            bitStack = BitStack.push(bitStack, isAddressRegistered);

            bytes memory toBytes;

            if (isAddressRegistered) {
                toBytes = RegIndex.encode(addressIndex);
            } else {
                toBytes = bytes.concat(bytes20(action.to));
            }

            res = bytes.concat(
                res,
                toBytes,
                PseudoFloat.encode(action.value),
                VLQ.encode(action.data.length),
                action.data
            );
        }

        bitStack = BitStack.reverse(bitStack);

        res = bytes.concat(
            VLQ.encode(actions.length),
            VLQ.encode(bitStack),
            res
        );

        return res;
    }
}
